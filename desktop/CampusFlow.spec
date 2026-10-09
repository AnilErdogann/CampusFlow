from pathlib import Path

from PyInstaller.utils.hooks import collect_all

project_root = Path(SPECPATH).resolve().parent
static_root = project_root / "app" / "static"
datas = [
    (str(path), str(Path("app/static") / path.relative_to(static_root).parent))
    for path in static_root.rglob("*")
    if path.is_file() and "downloads" not in path.relative_to(static_root).parts
]
binaries = []
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.lifespan.on",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.loops.asyncio",
    "app.main",
]

for package in ("rapidocr", "onnxruntime", "pypdfium2", "pypdfium2_raw"):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += [
        name
        for name in package_hiddenimports
        if not name.startswith(("rapidocr.inference_engine.tensorrt", "onnxruntime.quantization"))
    ]

analysis = Analysis(
    [str(project_root / "desktop" / "launcher.py")],
    pathex=[str(project_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "IPython", "jupyter", "matplotlib", "tkinter"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(analysis.pure)
executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="CampusFlow",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    contents_directory="_internal",
)
COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="CampusFlow",
)
