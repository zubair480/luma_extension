import os
import socket
import subprocess
import time
from pathlib import Path

from playwright.async_api import Browser, BrowserContext, Page, async_playwright

from src.config import ROOT

DEFAULT_CDP_URL = "http://127.0.0.1:9222"
CDP_PORT = 9222


def find_chrome_executable() -> Path | None:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    for path in candidates:
        if path.exists():
            return path
    return None


def chrome_user_data_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/User Data"


def is_cdp_available(cdp_url: str = DEFAULT_CDP_URL) -> bool:
    try:
        host, port_str = cdp_url.replace("http://", "").replace("https://", "").split(":")
        port = int(port_str.split("/")[0])
        host = host or "127.0.0.1"
    except ValueError:
        return False

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(1)
        return sock.connect_ex((host, port)) == 0


def is_chrome_running() -> bool:
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq chrome.exe"],
        capture_output=True,
        text=True,
        check=False,
    )
    return "chrome.exe" in result.stdout.lower()


def restart_chrome_with_debugging(
    cdp_port: int = CDP_PORT,
    user_data_dir: Path | None = None,
) -> Path:
    if is_chrome_running():
        subprocess.run(
            ["taskkill", "/IM", "chrome.exe", "/F"],
            capture_output=True,
            check=False,
        )
        for _ in range(20):
            if not is_chrome_running():
                break
            time.sleep(0.5)
        time.sleep(1)
    return start_chrome_with_debugging(cdp_port=cdp_port, user_data_dir=user_data_dir)


def start_chrome_with_debugging(
    cdp_port: int = CDP_PORT,
    user_data_dir: Path | None = None,
) -> Path:
    chrome = find_chrome_executable()
    if not chrome:
        raise RuntimeError(
            "Google Chrome not found. Install Chrome or set CHROME_EXECUTABLE in .env"
        )

    if is_chrome_running():
        raise RuntimeError(
            "Chrome is already running without remote debugging.\n"
            "Close all Chrome windows, then run: python main.py chrome-start"
        )

    profile = user_data_dir or chrome_user_data_dir()
    subprocess.Popen(
        [
            str(chrome),
            f"--remote-debugging-port={cdp_port}",
            "--remote-allow-origins=*",
            f'--user-data-dir={profile}',
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )

    for _ in range(40):
        if is_cdp_available(f"http://127.0.0.1:{cdp_port}"):
            return chrome
        time.sleep(0.5)

    raise RuntimeError("Chrome started but remote debugging port did not become available")


class BrowserSession:
    def __init__(
        self,
        profile_dir: Path | None = None,
        headless: bool = False,
        cdp_url: str | None = None,
        use_existing_chrome: bool | None = None,
    ):
        self.profile_dir = profile_dir or Path(
            os.getenv("BROWSER_PROFILE_DIR", ROOT / "browser_profile")
        )
        env_headless = os.getenv("HEADLESS")
        self.headless = (
            env_headless.lower() == "true" if env_headless is not None else headless
        )
        self.cdp_url = cdp_url or os.getenv("CHROME_CDP_URL", DEFAULT_CDP_URL)
        if use_existing_chrome is None:
            use_existing_chrome = os.getenv("USE_EXISTING_CHROME", "true").lower() == "true"
        self.use_existing_chrome = use_existing_chrome

        self._playwright = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None

    async def start(self) -> BrowserContext:
        self._playwright = await async_playwright().start()

        if self.use_existing_chrome:
            return await self._connect_existing_chrome()

        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._context = await self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.profile_dir),
            headless=self.headless,
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        return self._context

    async def _connect_existing_chrome(self) -> BrowserContext:
        if not is_cdp_available(self.cdp_url):
            if is_chrome_running():
                raise RuntimeError(
                    "Chrome is open but remote debugging is not enabled.\n\n"
                    "To use your logged-in Chrome (one-time setup):\n"
                    "  1. Close all Chrome windows\n"
                    "  2. Run: python main.py chrome-start\n"
                    "     (reopens Chrome with your same profile & logins)\n"
                    "  3. Run: python main.py run\n\n"
                    "After that, the agent opens new Luma tabs in your Chrome."
                )
            try:
                start_chrome_with_debugging()
            except RuntimeError as exc:
                raise RuntimeError(
                    f"{exc}\n\n"
                    "Run: python main.py chrome-start"
                ) from exc

        self._browser = await self._playwright.chromium.connect_over_cdp(self.cdp_url)

        if self._browser.contexts:
            self._context = self._browser.contexts[0]
        else:
            self._context = await self._browser.new_context()

        return self._context

    async def new_page(self) -> Page:
        if not self._context:
            await self.start()
        assert self._context is not None
        self._page = await self._context.new_page()
        return self._page

    async def is_logged_in(self, page: Page) -> bool:
        await page.goto("https://lu.ma/home", wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(2000)

        logged_in_selectors = [
            'a[href*="/home"]',
            'button:has-text("Create Event")',
            '[data-testid="user-menu"]',
            'img[alt*="avatar"]',
            'text=My Events',
        ]
        for selector in logged_in_selectors:
            try:
                if await page.locator(selector).first.is_visible(timeout=1500):
                    return True
            except Exception:
                continue

        sign_in = page.locator('text=Sign in').or_(page.locator('text=Log in'))
        try:
            if await sign_in.first.is_visible(timeout=1500):
                return False
        except Exception:
            pass

        return "sign" not in page.url.lower()

    async def close(self) -> None:
        if self.use_existing_chrome:
            # Disconnect only — leave the user's Chrome window open.
            if self._playwright:
                await self._playwright.stop()
            return

        if self._context:
            await self._context.close()
        if self._playwright:
            await self._playwright.stop()
