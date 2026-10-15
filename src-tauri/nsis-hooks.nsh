; 卸载时把「本地归档数据怎么办」交给用户决定。
;
; 之前是静默保留：卸载后没有任何提示，用户既不知道 %APPDATA% 下还留着一份完整的
; 归档库，也不知道它在哪里，重装后很容易以为数据丢了。这里把选择权交回去。
;
; 默认选「否 / 保留」是刻意的：归档是用户一条条攒下来的东西，不该在他点「卸载」
; 的那一下无声消失。想清干净的人多花一步，比数据被误删后再也找不回来划算得多。
;
; 路径与 Rust 侧保持一致：app_data_dir() = %APPDATA%\top.ehre.qzonearchive，
; 缓存目录在 %LOCALAPPDATA%\top.ehre.qzonearchive。标识符见 tauri.conf.json。
; 标识符改了就同步改这里，否则卸载时会删错目录（或漏删）。

; Only rename links pointing at this installation; never touch another app's shortcut.
!macro QZA_RENAME_LEGACY_SHORTCUT oldPath newPath
  !insertmacro IsShortcutTarget "${oldPath}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    ${IfNot} ${FileExists} "${newPath}"
      Rename "${oldPath}" "${newPath}"
    ${Else}
      !insertmacro IsShortcutTarget "${newPath}" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 = 1
        Delete "${oldPath}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro QZA_RENAME_LEGACY_SHORTCUT "$SMPROGRAMS\$AppStartMenuFolder\qzone-memory.lnk" "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !insertmacro QZA_RENAME_LEGACY_SHORTCUT "$SMPROGRAMS\qzone-memory.lnk" "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro QZA_RENAME_LEGACY_SHORTCUT "$DESKTOP\qzone-memory.lnk" "$DESKTOP\${PRODUCTNAME}.lnk"
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 静默卸载（/S）没有交互条件，走保留分支。
  IfSilent uninstall_keep_data

  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "是否同时删除本地归档数据？$\r$\n$\r$\n选择「否」将保留：$APPDATA\top.ehre.qzonearchive$\r$\n其中是已归档的内容、媒体索引与设备授权信息，重新安装后仍可直接继续使用。$\r$\n$\r$\n选择「是」将永久删除它们，无法恢复。" IDYES uninstall_remove_data

  Goto uninstall_keep_data

uninstall_remove_data:
  RMDir /r "$APPDATA\top.ehre.qzonearchive"
  RMDir /r "$LOCALAPPDATA\top.ehre.qzonearchive"
  Goto uninstall_done

uninstall_keep_data:
uninstall_done:
!macroend
