!include "common.nsh"
!include "extractAppPackage.nsh"

!ifdef SPLASH_IMAGE
  !include "${BUILD_RESOURCES_DIR}\splash\frases.nsh"
  Var rdShowSplash
  Var rdSteps
  Var rdDrawn
!endif

CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

Function .onInit
  !ifdef SPLASH_IMAGE
    StrCpy $rdShowSplash 1
    ${StdUtils.ParameterCnt} $R0
    StrCpy $R1 0
    ${While} $R1 <= $R0
      ${StdUtils.ParameterStr} $R2 $R1
      ${If} $R2 == "--hidden"
        StrCpy $rdShowSplash 0
      ${EndIf}
      IntOp $R1 $R1 + 1
    ${EndWhile}
    ${If} $rdShowSplash != 1
      SetSilent silent
    ${EndIf}
  !else
    SetSilent silent
  !endif

  !insertmacro check64BitAndSetRegView
FunctionEnd

!ifdef SPLASH_IMAGE
Function rdStartPhrases
  System::Call 'kernel32::GetCurrentProcessId() i .R6'
  StrCpy $R0 0
  ${Do}
    System::Call 'user32::FindWindowEx(p 0, p R0, t "NSISBGImage", p 0) p .R0'
    ${If} $R0 == 0
      Return
    ${EndIf}
    System::Call 'user32::GetWindowThreadProcessId(p R0, *i .R7)'
  ${LoopUntil} $R7 == $R6

  System::Call 'user32::GetWindowLong(p R0, i -16) i .R1'
  IntOp $R1 $R1 | 0x02000000
  System::Call 'user32::SetWindowLong(p R0, i -16, i R1)'

  System::Call 'user32::CreateWindowEx(i 0, t "SysAnimate32", p 0, i 0x50000000, i 36, i 220, i 408, i 20, p R0, p 0, p 0, p 0) p .R2'
  ${If} $R2 == 0
    Return
  ${EndIf}
  SendMessage $R2 0x467 0 "STR:$PLUGINSDIR\frases.avi" $R3
  ${If} $R3 == 0
    System::Call 'user32::DestroyWindow(p R2)'
    Return
  ${EndIf}

  System::Call 'kernel32::GetTickCount() i .R4'
  IntOp $R4 $R4 & 0x7FFFFFFF
  IntOp $R4 $R4 % ${RICKDEV_PHRASE_COUNT}
  IntOp $R4 $R4 * ${RICKDEV_PHRASE_FRAMES}
  IntOp $R5 ${RICKDEV_PHRASE_COUNT} * ${RICKDEV_PHRASE_FRAMES}
  IntOp $R5 $R5 + $R4
  IntOp $R5 $R5 - 1
  IntOp $R5 $R5 << 16
  IntOp $R5 $R5 | $R4
  SendMessage $R2 0x465 -1 $R5
FunctionEnd

Function rdDrawSplash
  ${If} $rdShowSplash != 1
  ${OrIf} $rdDrawn >= $rdSteps
    Return
  ${EndIf}
  ${While} $rdDrawn < $rdSteps
    IntOp $R3 $rdDrawn * 17
    IntOp $R3 $R3 + 36
    BgImage::AddImage "$PLUGINSDIR\barra.bmp" $R3 252
    IntOp $rdDrawn $rdDrawn + 1
  ${EndWhile}
  BgImage::Redraw
FunctionEnd

Function rdExtractProgress
  Pop $R8
  Pop $R9
  ${If} $R8 > $R9
    StrCpy $R4 $R8
    StrCpy $R8 $R9
    StrCpy $R9 $R4
  ${EndIf}

  IntOp $R4 $R9 / ${RICKDEV_BAR_SEGMENTS}
  StrCpy $R5 0
  ${If} $R4 > 0
    IntOp $R5 $R8 / $R4
  ${EndIf}
  ${If} $R5 > ${RICKDEV_BAR_SEGMENTS}
    StrCpy $R5 ${RICKDEV_BAR_SEGMENTS}
  ${EndIf}
  ${If} $R5 > $rdSteps
    StrCpy $rdSteps $R5
    Call rdDrawSplash
  ${EndIf}
FunctionEnd

Function rdAppWindowShown
  StrCpy $R6 0
  StrCpy $R7 0
  ${Do}
    System::Call 'user32::FindWindowEx(p 0, p R7, t "Chrome_WidgetWin_1", p 0) p .R7'
    ${If} $R7 == 0
      Return
    ${EndIf}
    System::Call 'user32::IsWindowVisible(p R7) i .R8'
    ${If} $R8 != 0
      System::Call 'user32::GetWindowThreadProcessId(p R7, *i .R9)'
      ${If} $R9 == $R3
        StrCpy $R6 1
        Return
      ${EndIf}
    ${EndIf}
  ${Loop}
FunctionEnd

Function rdRunWithSplash
  ${StdUtils.ExecShellWaitEx} $R1 $R2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$R0"
  ${If} $R1 != "ok"
    BgImage::Destroy
    ${If} $R1 == "no_wait"
      StrCpy $0 0
    ${Else}
      ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
    ${EndIf}
    Return
  ${EndIf}

  StrCpy $R1 $R2 "" 6
  IntOp $R1 0x$R1 + 0
  System::Call 'kernel32::GetProcessId(p R1) i .R3'
  StrCpy $R5 0
  ${Do}
    System::Call 'kernel32::WaitForSingleObject(p R1, i 100) i .R4'
    ${If} $R4 != 258
      ${Break}
    ${EndIf}
    Call rdAppWindowShown
    ${If} $R6 == 1
      ${Break}
    ${EndIf}
    IntOp $R5 $R5 + 100
  ${LoopUntil} $R5 >= 60000

  BgImage::Destroy
  ${StdUtils.WaitForProcEx} $0 $R2
FunctionEnd
!endif

!macro rdExtractEmbeddedAppPackage
  !ifdef COMPRESS
    SetCompress off
  !endif

  Var /GLOBAL packageArch

  !insertmacro identify_package
  !insertmacro compute_files_for_current_arch

  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif

  !ifdef ZIP_COMPRESSION
    !insertmacro decompress
  !else
    !ifdef SPLASH_IMAGE
      ${If} $rdShowSplash == 1
        GetFunctionAddress $R9 rdExtractProgress
        Nsis7z::ExtractWithCallback "$PLUGINSDIR\app-$packageArch.7z" $R9
        StrCpy $rdSteps ${RICKDEV_BAR_SEGMENTS}
        Call rdDrawSplash
      ${Else}
        Nsis7z::Extract "$PLUGINSDIR\app-$packageArch.7z"
      ${EndIf}
    !else
      Nsis7z::Extract "$PLUGINSDIR\app-$packageArch.7z"
    !endif
  !endif

  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)"
    Quit

  !insertmacro custom_files_post_decompression
!macroend

Function .onGUIInit
  InitPluginsDir

  !ifdef SPLASH_IMAGE
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    File "/oname=$PLUGINSDIR\frases.avi" "${BUILD_RESOURCES_DIR}\splash\frases.avi"
    File "/oname=$PLUGINSDIR\barra.bmp" "${BUILD_RESOURCES_DIR}\splash\barra.bmp"
    StrCpy $rdSteps 0
    StrCpy $rdDrawn 0
    BgImage::SetBg "$PLUGINSDIR\splash.bmp"
    BgImage::Redraw
    Call rdStartPhrases
  !endif
FunctionEnd

Section
  !ifdef SPLASH_IMAGE
    HideWindow
  !endif

  StrCpy $INSTDIR "$PLUGINSDIR\app"
  !ifdef UNPACK_DIR_NAME
    StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"
  !endif

  RMDir /r $INSTDIR
  SetOutPath $INSTDIR

  !ifdef APP_DIR_64
    !ifdef APP_DIR_ARM64
      !ifdef APP_DIR_32
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${elseif} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${else}
          File /r "${APP_DIR_64}\*.*"
        ${endIf}
      !endif
    !else
      !ifdef APP_DIR_32
        ${if} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        File /r "${APP_DIR_64}\*.*"
      !endif
    !endif
  !else
    !ifdef APP_DIR_32
      File /r "${APP_DIR_32}\*.*"
    !else
      !insertmacro rdExtractEmbeddedAppPackage
    !endif
  !endif

  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
  ${StdUtils.GetAllParameters} $R0 0

  !ifdef SPLASH_IMAGE
    ${If} $rdShowSplash == 1
      Call rdRunWithSplash
    ${Else}
      ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
    ${EndIf}
  !else
    ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
  !endif
  SetErrorLevel $0

  SetOutPath $EXEDIR
  RMDir /r $INSTDIR
SectionEnd
