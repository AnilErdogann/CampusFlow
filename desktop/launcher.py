"""Start the packaged CampusFlow server and open its local web interface."""

from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

MUTEX_NAME = "Local\\CampusFlowDesktopApp"


def _prepare_user_data() -> None:
    local_app_data = Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    data_dir = Path(os.getenv("CAMPUSFLOW_DATA_DIR", local_app_data / "CampusFlow"))
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ["CAMPUSFLOW_DATA_DIR"] = str(data_dir)
    os.environ["CAMPUSFLOW_SKIP_LEGACY_MIGRATION"] = "1"
    os.environ.setdefault("PYTHONUTF8", "1")
    os.chdir(data_dir)


def _already_running() -> bool:
    if sys.platform != "win32":
        return False
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        return False
    return kernel32.GetLastError() == 183


def _address() -> tuple[str, int, str]:
    host = os.getenv("CAMPUSFLOW_HOST", "127.0.0.1")
    port = int(os.getenv("CAMPUSFLOW_PORT", "8765"))
    url_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    return host, port, f"http://{url_host}:{port}/"


def _open_browser_when_ready(host: str, port: int, url: str) -> None:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/health")
    for _ in range(60):
        try:
            with urllib.request.urlopen(request, timeout=1) as response:
                if response.status == 200:
                    webbrowser.open(url)
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.5)


def main() -> None:
    _prepare_user_data()
    host, port, app_url = _address()
    if _already_running():
        webbrowser.open(app_url)
        return

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
            if response.status == 200:
                webbrowser.open(app_url)
                return
    except (OSError, urllib.error.URLError):
        pass

    import uvicorn

    from app.main import app

    threading.Thread(target=_open_browser_when_ready, args=(host, port, app_url), daemon=True).start()
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="warning",
        loop="asyncio",
        http="h11",
        ws="none",
    )


if __name__ == "__main__":
    main()
