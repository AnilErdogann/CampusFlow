#define AppName "CampusFlow"
#define AppVersion "1.0.0"
#define AppPublisher "CampusFlow"
#define AppExeName "CampusFlow.exe"

[Setup]
AppId={{8B5016E8-2D2D-4B4E-A3E8-14D97F55D532}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\CampusFlow
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=CampusFlow-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExeName}
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Masaüstü kısayolu oluştur"; GroupDescription: "Ek kısayollar:"; Flags: unchecked

[Files]
Source: "..\dist\CampusFlow\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\scripts\configure_local_admin.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\CampusFlow"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\CampusFlow"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\configure_local_admin.ps1"""; Flags: runhidden waituntilterminated
Filename: "{app}\{#AppExeName}"; Description: "CampusFlow'u başlat"; Flags: postinstall nowait skipifsilent
