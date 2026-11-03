; Hooks Tauri's NSIS installer runs (bundle > windows > nsis > installerHooks in tauri.conf.json).

; The app was called Blacksite until 0.1.0. Installing Athena Agents, by hand or as an update, goes
; into a folder of its own, so remove the Blacksite copy: its files, shortcuts and its entry in
; Installed apps. Both use the same data folder (it follows the bundle identifier), and a silent
; uninstall never deletes it: only the uninstaller's "Delete the application data" box does.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Blacksite" "InstallLocation"
  ; written with quotes around it
  StrCpy $R2 $R1 1
  ${If} $R2 == '"'
    StrCpy $R1 $R1 -1 1
  ${EndIf}
  ; never the folder just installed into: its uninstaller would delete the new files
  ${If} $R1 != ""
  ${AndIf} $R1 != $INSTDIR
  ${AndIf} ${FileExists} "$R1\uninstall.exe"
    DetailPrint "Removing Blacksite, the app's old name"
    ; _?= runs it in place, so this waits for it; it then can't delete itself
    ExecWait '"$R1\uninstall.exe" /S _?=$R1'
    Delete "$R1\uninstall.exe"
    RMDir "$R1"
  ${EndIf}
!macroend
