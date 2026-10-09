@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1

if not exist .venv\Scripts\python.exe (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 -m venv .venv
  ) else (
    where python >nul 2>nul
    if errorlevel 1 (
      echo Python 3.11 or later is required. Install Python from https://www.python.org/downloads/windows/
      pause
      exit /b 1
    )
    python -m venv .venv
  )
  if errorlevel 1 goto setup_error
)

.venv\Scripts\python.exe -c "import fastapi, uvicorn, sqlalchemy, pydantic_settings, jose, bcrypt, email_validator, multipart, pypdfium2, PIL, rapidocr, onnxruntime" >nul 2>nul
if errorlevel 1 (
  echo CampusFlow bileşenleri hazırlanıyor. İlk kurulum birkaç dakika sürebilir.
  .venv\Scripts\python.exe -m pip install -r requirements.txt
  if errorlevel 1 goto setup_error
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure_local_admin.ps1"
if errorlevel 1 goto setup_error

start "" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0scripts\control_panel.ps1"
exit /b 0

:setup_error
echo CampusFlow kurulumu tamamlanamadı. İnternet bağlantını kontrol edip start.bat dosyasını yeniden çalıştır.
pause
exit /b 1
