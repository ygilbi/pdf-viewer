; PDF Viewer - extra NSIS steps (electron-builder `nsis.include`). ASCII only on purpose.
;
; electron-builder's own `fileAssociations` handling (macro registerFileAssociations,
; run just before customInstall) already wrote, under SHELL_CONTEXT (= HKCU, per-user):
;   Software\Classes\.pdf                        (default) = PDFViewer.Document
;   Software\Classes\.pdf\OpenWithProgids        PDFViewer.Document (REG_NONE)
;   Software\Classes\PDFViewer.Document          DefaultIcon, shell\open\command
; and copied the file-type icon to $INSTDIR\resources\file-pdf.ico.
; Its uninstaller (unregisterFileAssociations) removes the ProgID key and the
; OpenWithProgids value. Here we:
;   - normalise the ProgID values (quoted exe path, ",0" icon index, Application info),
;   - register the app as a Default Apps candidate (Applications\, Capabilities,
;     RegisteredApplications) so it is listed in Settings > Apps > Default apps,
;   - tell Explorer (SHCNE_ASSOCCHANGED) so .pdf files get the new icon at once,
;   - interactive installs only: open THIS app's Default apps page in Settings.
; The per-user UserChoice is hash-protected by Windows; no installer may set it.

!define PDFV_PROGID "PDFViewer.Document"
!define PDFV_EXE "PDFViewer.exe"
!define PDFV_REGNAME "PDF Viewer"
!define PDFV_CAPS "Software\PDFViewer\Capabilities"
!define PDFV_DESC "View PDF drawings and measure aluminium facade areas"
!define PDFV_SETTINGS_URI "ms-settings:defaultapps?registeredAppUser=PDF%20Viewer"

!macro pdfvNotifyAssocChanged
  ; SHCNE_ASSOCCHANGED, SHCNF_FLUSH
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend

!macro customInstall
  ; ---- ProgID
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}" "" "PDF Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}" "FriendlyTypeName" "PDF Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}\DefaultIcon" "" '"$INSTDIR\resources\file-pdf.ico",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}\Application" "ApplicationName" "${PDFV_REGNAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}\Application" "ApplicationIcon" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}\Application" "ApplicationDescription" "${PDFV_DESC}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}\Application" "AppUserModelID" "${APP_ID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${PDFV_PROGID}"

  ; ---- "Open with" list entry
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${PDFV_EXE}" "FriendlyAppName" "${PDFV_REGNAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${PDFV_EXE}\DefaultIcon" "" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${PDFV_EXE}\SupportedTypes" ".pdf" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${PDFV_EXE}\shell\open\command" "" '"$appExe" "%1"'

  ; ---- Default Apps registration
  WriteRegStr SHELL_CONTEXT "${PDFV_CAPS}" "ApplicationName" "${PDFV_REGNAME}"
  WriteRegStr SHELL_CONTEXT "${PDFV_CAPS}" "ApplicationDescription" "${PDFV_DESC}"
  WriteRegStr SHELL_CONTEXT "${PDFV_CAPS}" "ApplicationIcon" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "${PDFV_CAPS}\FileAssociations" ".pdf" "${PDFV_PROGID}"
  WriteRegStr SHELL_CONTEXT "${PDFV_CAPS}\MimeAssociations" "application/pdf" "${PDFV_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${PDFV_REGNAME}" "${PDFV_CAPS}"

  ; ---- `start PDFViewer` / Win+R
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${PDFV_EXE}" "" "$appExe"
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${PDFV_EXE}" "Path" "$INSTDIR"

  !insertmacro pdfvNotifyAssocChanged

  ; ---- Ask the user once (Windows only allows the user to pick the default).
  ; Not for silent installs (/S, CI) or auto-updates, and not when we already are the default.
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoiceLatest\ProgId" "ProgId"
    ${If} $0 == ""
      ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice" "ProgId"
    ${EndIf}
    ${If} $0 != "${PDFV_PROGID}"
      ExecShell "open" "${PDFV_SETTINGS_URI}"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller with --updated; the new installer rewrites everything.
  ${IfNot} ${isUpdated}
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${PDFV_PROGID}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${PDFV_PROGID}"
    ; electron-builder set .pdf's default value to our ProgID; drop it only if it is still ours
    ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.pdf" ""
    ${If} $0 == "${PDFV_PROGID}"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf" ""
    ${EndIf}
    DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${PDFV_EXE}"
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${PDFV_REGNAME}"
    DeleteRegKey SHELL_CONTEXT "Software\PDFViewer"
    DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${PDFV_EXE}"
    !insertmacro pdfvNotifyAssocChanged
  ${EndIf}
!macroend
