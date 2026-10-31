; The Windows installer of pdfkiln (Inno Setup 6), made from the folder
; that scripts/package.ts leaves for the zip archive. It installs where the
; old wkhtmltopdf installer did, C:\Program Files\wkhtmltopdf, so that the
; paths libraries and guides give keep working; adding bin to the PATH is
; offered, not checked.
;
;   iscc /DVersion=<version> /DSource=<dist\package\...\wkhtmltopdf> /DOutput=<folder> packaging\windows\pdfkiln.iss
;
; Output: pdfkiln-<version>-windows-x64-setup.exe

#ifndef Version
  #error Version is required (/DVersion=...)
#endif
#ifndef Source
  #error Source is required (/DSource=...)
#endif
#ifndef Output
  #define Output "."
#endif

[Setup]
AppId={{6F3C2B4E-8D1A-4C5B-9E7F-2A1D3B4C5E6F}
AppName=PDFKiln
AppVersion={#Version}
AppVerName=PDFKiln {#Version}
AppPublisher=Jamalofski
AppPublisherURL=https://pdfkiln.org
AppSupportURL=https://github.com/Jamalofski/pdfkiln/issues
AppUpdatesURL=https://github.com/Jamalofski/pdfkiln/releases
DefaultDirName={commonpf64}\wkhtmltopdf
DisableProgramGroupPage=yes
LicenseFile={#Source}\LICENSE
OutputDir={#Output}
OutputBaseFilename=pdfkiln-{#Version}-windows-x64-setup
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
Compression=lzma2/max
SolidCompression=yes
ChangesEnvironment=yes
UninstallDisplayName=PDFKiln {#Version} (wkhtmltopdf)

[Tasks]
Name: addtopath; Description: "Add {app}\bin to the PATH"; Flags: unchecked

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Tasks: addtopath; Check: NotInPath(ExpandConstant('{app}\bin'))

[Code]
function NotInPath(Dir: string): Boolean;
var
  Path: string;
begin
  if not RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment', 'Path', Path) then
    Path := '';
  Result := Pos(';' + Lowercase(Dir) + ';', ';' + Lowercase(Path) + ';') = 0;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Path, Dir: string;
  P: Integer;
begin
  if CurUninstallStep <> usPostUninstall then
    exit;
  if not RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment', 'Path', Path) then
    exit;
  Dir := ExpandConstant('{app}\bin');
  P := Pos(';' + Lowercase(Dir), Lowercase(Path));
  if P > 0 then
  begin
    Delete(Path, P, Length(Dir) + 1);
    RegWriteExpandStringValue(HKLM, 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment', 'Path', Path);
  end;
end;
