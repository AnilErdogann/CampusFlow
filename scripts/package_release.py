"""Create clean, separate Windows, Android, and iOS CampusFlow install bundles."""

import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRS = {
    ".git",
    ".ruff_cache",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "outputs",
    "test-results",
    "tests",
    "work",
}
EXCLUDED_NAMES = {".env", "campusflow.db", "test_campusflow.db"}

PLATFORM_GUIDES = {
    "PC": """CAMPUSFLOW FOR WINDOWS PC

Extract this ZIP into a writable folder and double-click start.bat. The first
launch installs Python packages (Python 3.11+ and an internet connection are
required); later launches reuse them. The app opens at http://127.0.0.1:8765.
Keep the command window open while using it. Your account database and secret
are stored in %LOCALAPPDATA%\\CampusFlow and are not included in this clean ZIP.

For the same account on phones, deploy the shared HTTPS server described in
DEPLOYMENT.md. This package is a Windows quick-start bundle, not a signed EXE.
""",
    "Android": """CAMPUSFLOW FOR ANDROID

This bundle contains the installable CampusFlow web app and its Android setup
guide. First deploy the shared server at a public HTTPS address as explained in
DEPLOYMENT.md. On the Android device, open that address in Chrome and choose
Install app (or Add to Home screen). Sign in with the same account used on PC.

This is a PWA package, not an APK. The server address must exist before the
mobile app can sync accounts, PDFs, and messages.
""",
    "iOS": """CAMPUSFLOW FOR IPHONE AND IPAD

This bundle contains the installable CampusFlow web app and its iOS setup
guide. First deploy the shared server at a public HTTPS address as explained in
DEPLOYMENT.md. On the iPhone/iPad, open that address in Safari, tap Share,
choose Add to Home Screen, turn on Open as Web App, and tap Add. Sign in with
the same account used on PC.

This is a PWA package, not a signed IPA. The server address must exist before
the mobile app can sync accounts, PDFs, and messages.
""",
}


def included_files():
    for path in sorted(ROOT.rglob("*")):
        relative = path.relative_to(ROOT)
        if any(part in EXCLUDED_DIRS for part in relative.parts):
            continue
        if path.is_dir():
            continue
        if path.name in EXCLUDED_NAMES or path.suffix in {".pyc", ".db", ".sqlite", ".sqlite3"}:
            continue
        if path.name == ".env.example" or not path.name.startswith("."):
            yield path, relative


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python scripts/package_release.py OUTPUT_DIRECTORY")
        return 2
    output = Path(sys.argv[1]).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    source_files = list(included_files())
    for platform, guide in PLATFORM_GUIDES.items():
        package = output / f"CampusFlow-{platform}.zip"
        with ZipFile(package, "w", compression=ZIP_DEFLATED, compresslevel=8) as archive:
            archive.writestr("PLATFORM-INSTALL.txt", guide)
            for file_path, relative in source_files:
                archive.write(file_path, Path("CampusFlow") / relative)
        print(f"Created {package} ({package.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
