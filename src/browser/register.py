import os
import re
from dataclasses import dataclass
from pathlib import Path

from playwright.async_api import Page

from src.config import ROOT, ensure_data_dir


@dataclass
class RegistrationResult:
    success: bool
    status: str
    message: str


class LumaRegistrar:
    REGISTER_BUTTONS = [
        'button:has-text("Register")',
        'button:has-text("RSVP")',
        'button:has-text("Get Tickets")',
        'button:has-text("Request to Join")',
        'a:has-text("Register")',
        '[data-testid="register-button"]',
    ]

    SUBMIT_BUTTONS = [
        'button:has-text("Register")',
        'button:has-text("Submit")',
        'button:has-text("Complete Registration")',
        'button:has-text("Confirm")',
        'button[type="submit"]',
    ]

    SUCCESS_INDICATORS = [
        "You're going",
        "You're registered",
        "Registration confirmed",
        "You're on the list",
        "You're on the waitlist",
        "Pending approval",
        "Already registered",
    ]

    PAID_INDICATORS = [
        r"\$\d+",
        "Buy ticket",
        "Purchase",
        "Paid event",
    ]

    def __init__(self, profile: dict):
        self.profile = profile
        self.screenshots_dir = ensure_data_dir() / "screenshots"
        self.screenshots_dir.mkdir(exist_ok=True)

    def _field_value(self, label: str) -> str | None:
        label_lower = label.lower().strip()

        mapping = {
            "first name": self.profile.get("first_name"),
            "last name": self.profile.get("last_name"),
            "email": self.profile.get("email"),
            "work email": self.profile.get("work_email"),
            "phone": self.profile.get("phone"),
            "phone number": self.profile.get("phone"),
            "city": self.profile.get("location"),
            "location": self.profile.get("location"),
            "city / location": self.profile.get("location"),
            "job title": self.profile.get("job_title"),
            "role": self.profile.get("job_title"),
            "company": self.profile.get("company"),
            "organization": self.profile.get("company"),
            "linkedin": self.profile.get("linkedin"),
            "github": self.profile.get("github"),
            "website": self.profile.get("website"),
            "personal website": self.profile.get("website"),
        }

        for key, value in mapping.items():
            if key in label_lower and value:
                return str(value)

        defaults = self.profile.get("default_answers") or {}
        for question, answer in defaults.items():
            if question.lower() in label_lower or label_lower in question.lower():
                return str(answer)

        return None

    def _generic_answer(self, label: str) -> str:
        defaults = self.profile.get("default_answers") or {}
        for answer in defaults.values():
            if answer:
                return str(answer)

        return (
            f"I'm {self.profile.get('first_name', '')} {self.profile.get('last_name', '')}, "
            f"a {self.profile.get('job_title', 'Software Engineer')} at "
            f"{self.profile.get('company', 'my company')}. "
            f"I'm interested in AI and tech events in San Francisco."
        )

    async def _maybe_llm_answer(self, question: str) -> str | None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return None

        try:
            from openai import OpenAI

            client = OpenAI(api_key=api_key)
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Write a short, professional answer (1-2 sentences) for a Luma "
                            "event registration form. Be specific and authentic."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Question: {question}\n\n"
                            f"Profile: {self.profile.get('first_name')} "
                            f"{self.profile.get('last_name')}, "
                            f"{self.profile.get('job_title')} at "
                            f"{self.profile.get('company')}, "
                            f"based in {self.profile.get('location')}."
                        ),
                    },
                ],
                max_tokens=120,
            )
            return response.choices[0].message.content.strip()
        except Exception:
            return None

    async def _fill_visible_fields(self, page: Page) -> None:
        inputs = page.locator("input:visible, textarea:visible")
        count = await inputs.count()

        for i in range(count):
            field = inputs.nth(i)
            field_type = (await field.get_attribute("type") or "text").lower()
            if field_type in ("hidden", "checkbox", "radio", "file"):
                continue

            current = await field.input_value() if field_type != "textarea" else await field.input_value()
            if current and current.strip():
                continue

            label = await self._get_field_label(page, field)
            value = self._field_value(label) if label else None

            if not value and label:
                value = await self._maybe_llm_answer(label) or self._generic_answer(label)

            if value:
                await field.fill(value)
                await page.wait_for_timeout(200)

    async def _get_field_label(self, page: Page, field) -> str:
        field_id = await field.get_attribute("id")
        if field_id:
            label_el = page.locator(f'label[for="{field_id}"]')
            if await label_el.count():
                return (await label_el.first.inner_text()).strip()

        aria = await field.get_attribute("aria-label")
        if aria:
            return aria.strip()

        placeholder = await field.get_attribute("placeholder")
        if placeholder:
            return placeholder.strip()

        name = await field.get_attribute("name")
        return name or ""

    async def _screenshot(self, page: Page, name: str) -> None:
        path = self.screenshots_dir / f"{name}.png"
        await page.screenshot(path=str(path), full_page=True)

    async def _detect_paid(self, page: Page) -> bool:
        content = await page.content()
        for pattern in self.PAID_INDICATORS:
            if re.search(pattern, content, re.IGNORECASE):
                price_context = re.search(r"\$\d+(?:\.\d{2})?", content)
                if price_context and price_context.group() not in ("$0", "$0.00"):
                    return True
        return False

    async def _already_registered(self, page: Page) -> bool:
        content = await page.inner_text("body")
        for indicator in self.SUCCESS_INDICATORS:
            if indicator.lower() in content.lower():
                return True
        return False

    async def register(self, page: Page, event_url: str, *, dry_run: bool = False) -> RegistrationResult:
        await page.goto(event_url, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(2500)

        if await self._already_registered(page):
            return RegistrationResult(True, "already_registered", "Already registered for this event")

        if await self._detect_paid(page):
            return RegistrationResult(False, "skipped_paid", "Event appears to be paid — skipping")

        body = await page.inner_text("body")
        if "sold out" in body.lower():
            return RegistrationResult(False, "sold_out", "Event is sold out")

        if dry_run:
            return RegistrationResult(True, "dry_run", "Would attempt registration (dry run)")

        clicked = False
        for selector in self.REGISTER_BUTTONS:
            btn = page.locator(selector).first
            try:
                if await btn.is_visible(timeout=2000):
                    await btn.click()
                    clicked = True
                    await page.wait_for_timeout(2000)
                    break
            except Exception:
                continue

        if not clicked:
            await self._screenshot(page, "no_register_button")
            return RegistrationResult(False, "no_button", "Could not find Register/RSVP button")

        if await self._detect_paid(page):
            return RegistrationResult(False, "skipped_paid", "Registration form shows paid tickets")

        for _ in range(3):
            await self._fill_visible_fields(page)

            for selector in self.SUBMIT_BUTTONS:
                submit = page.locator(selector).last
                try:
                    if await submit.is_visible(timeout=1500) and await submit.is_enabled():
                        await submit.click()
                        await page.wait_for_timeout(3000)
                        break
                except Exception:
                    continue

            if await self._already_registered(page):
                return RegistrationResult(True, "registered", "Successfully registered")

            await self._fill_visible_fields(page)

        content = await page.inner_text("body")
        for indicator in self.SUCCESS_INDICATORS:
            if indicator.lower() in content.lower():
                status = "waitlisted" if "waitlist" in indicator.lower() else "registered"
                return RegistrationResult(True, status, f"Registration complete: {indicator}")

        await self._screenshot(page, "registration_failed")
        return RegistrationResult(False, "failed", "Registration could not be confirmed")
