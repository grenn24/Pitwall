; Custom NSIS include for the Pitwall installer.
;
; electron-builder's createDesktopShortcut / createStartMenuShortcut options
; create shortcuts silently, with nothing for the user to untick. This adds a
; page after the install-location step with both options visible and checked by
; default, and takes over creating and removing the shortcuts so the choice is
; actually honoured.
;
; The uninstaller is compiled in a separate pass with BUILD_UNINSTALLER set, and
; electron-builder turns NSIS warnings into errors. Anything the uninstaller
; does not reference — these variables, these functions — has to be excluded
; from that pass or the build fails on "variable never set" and "function not
; referenced".

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER

Var ShortcutDialog
Var DesktopCheckbox
Var StartMenuCheckbox
Var CreateDesktop
Var CreateStartMenu

Function ShortcutOptionsShow
  nsDialogs::Create 1018
  Pop $ShortcutDialog
  ${If} $ShortcutDialog == error
    Abort
  ${EndIf}

  ; The MUI header macro is not in scope where electron-builder injects this
  ; file, so the page introduces itself with a plain label instead.
  ${NSD_CreateLabel} 0 0 100% 20u "Choose where to add Pitwall."
  Pop $0

  ${NSD_CreateCheckbox} 0 26u 100% 12u "Create a &desktop shortcut"
  Pop $DesktopCheckbox
  ${NSD_Check} $DesktopCheckbox

  ${NSD_CreateCheckbox} 0 44u 100% 12u "Add a &Start menu entry"
  Pop $StartMenuCheckbox
  ${NSD_Check} $StartMenuCheckbox

  nsDialogs::Show
FunctionEnd

Function ShortcutOptionsLeave
  ${NSD_GetState} $DesktopCheckbox $CreateDesktop
  ${NSD_GetState} $StartMenuCheckbox $CreateStartMenu
FunctionEnd

!endif

!macro customPageAfterChangeDir
  Page custom ShortcutOptionsShow ShortcutOptionsLeave
!macroend

; A silent install shows no page, so the leave handler never runs and both
; variables stay zero. Default them to checked, matching what the visible
; installer offers.
!macro customInit
  StrCpy $CreateDesktop ${BST_CHECKED}
  StrCpy $CreateStartMenu ${BST_CHECKED}
!macroend

!macro customInstall
  ${If} $CreateDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}

  ${If} $CreateStartMenu == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend

!macro customUnInstall
  ; Unconditional: electron-builder is no longer tracking these shortcuts, so
  ; the uninstaller must remove whatever the install may have created.
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
!macroend
