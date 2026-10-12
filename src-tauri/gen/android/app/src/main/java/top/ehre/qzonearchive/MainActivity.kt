package top.ehre.qzonearchive

import android.os.Bundle
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    val provider = WebView.getCurrentWebViewPackage()
    // 厂商组件的版本号未必等于 Chromium 版本，优先读取实际内核的 UA。
    val major = Regex("(?:Chrome|Chromium)/(\\d+)")
      .find(webView.settings.userAgentString)?.groupValues?.get(1)?.toIntOrNull()
      ?: provider?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
    if (major < 111) {
      webView.visibility = View.INVISIBLE
      val packageName = provider?.packageName ?: "com.google.android.webview"
      AlertDialog.Builder(this)
        .setTitle("请更新系统网页组件")
        .setMessage("拾忆支持 Android 8.0 及以上。当前网页组件版本较旧，请将系统 WebView 更新至 111 或以上，再重新打开拾忆。")
        .setCancelable(false)
        .setPositiveButton("打开应用商店") { _, _ ->
          try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$packageName")))
          } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
          }
          finish()
        }
        .setNegativeButton("退出") { _, _ -> finish() }
        .show()
      return
    }
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // 弹层先处理返回键；没有弹层时交回 Tauri 的页面历史和退出逻辑。
        webView.evaluateJavascript("""
          (() => {
            const overlay = [...document.querySelectorAll('.p-dialog[aria-modal="true"], .p-drawer[aria-modal="true"]')]
              .find(element => element.getClientRects().length > 0);
            if (!overlay) return false;
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
            }));
            return true;
          })()
        """.trimIndent()) { handled ->
          if (handled != "true") {
            isEnabled = false
            try {
              onBackPressedDispatcher.onBackPressed()
            } finally {
              isEnabled = true
            }
          }
        }
      }
    })
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val safeTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val safe = windowInsets.getInsets(safeTypes)
      val keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      // 在原生层适配旧版 WebView；横屏挖孔和键盘同样不能遮住页面。
      view.setPadding(safe.left, safe.top, safe.right, max(safe.bottom, keyboard.bottom))
      // 已由父容器处理的尺寸归零后继续下发，避免新版 WebView 重复留白。
      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(safeTypes or WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(content)
  }
}
