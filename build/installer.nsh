; PSX Rando Hub installer additions (electron-builder NSIS include).
; A licensed download is a folder with "PSX Rando Hub Setup.exe" and license.json (added by Rando Hub for
; that player). The installer copies license.json (and LICENSED-TO.txt) into the install folder, where the
; app looks for it. Self-updates run the same Setup silently (/S --force-run) from the unpacked update.

!macro customInit
  ${IfNot} ${Silent}
  ${AndIfNot} ${FileExists} "$EXEDIR\license.json"
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Your license file (license.json) isn't next to this installer.$\r$\n$\r$\nExtract the whole zip first (right-click it, Extract All), then run PSX Rando Hub Setup from the extracted folder.$\r$\n$\r$\nInstall anyway? Without the license file PSX Rando Hub stays locked." IDOK psx_lic_ok
    Quit
    psx_lic_ok:
  ${EndIf}
!macroend

!macro customInstall
  ${If} ${FileExists} "$EXEDIR\license.json"
    CopyFiles /SILENT "$EXEDIR\license.json" "$INSTDIR"
  ${EndIf}
  ${If} ${FileExists} "$EXEDIR\LICENSED-TO.txt"
    CopyFiles /SILENT "$EXEDIR\LICENSED-TO.txt" "$INSTDIR"
  ${EndIf}
!macroend
