; Uninstall removes the sign-in entry (electron/desktop.ts LOGIN_ITEM_NAME). An upgrade's uninstall keeps it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Terrace"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Terrace"
  ${endIf}
!macroend
