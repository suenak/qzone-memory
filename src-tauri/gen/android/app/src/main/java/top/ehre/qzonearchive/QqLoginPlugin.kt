package top.ehre.qzonearchive

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.webkit.SslErrorHandler
import android.net.http.SslError
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject

/** Native QQ login page; no JS bridge or credentials in frontend storage. */
@TauriPlugin
class QqLoginPlugin(private val activity: Activity) : Plugin(activity) {
    private var dialog: Dialog? = null
    private var browser: WebView? = null
    private var state = "webLoginCancelled"
    private var message = "登录已取消"
    // Let Qzone generate the current mobile login URL and parameters.
    private val loginUrl = "https://h5.qzone.qq.com/mqzone/index"

    private fun trusted(uri: Uri): Boolean {
        val host = uri.host ?: return false
        return uri.scheme == "https" && (host == "qq.com" || host.endsWith(".qq.com")) && uri.userInfo == null
    }

    private fun close() {
        dialog?.dismiss()
        browser?.stopLoading()
        browser?.destroy()
        browser = null
        dialog = null
    }

    @Command
    fun start(invoke: Invoke) {
        close()
        // Clear this app's WebView login profile; never another app's QQ session.
        val cookies = CookieManager.getInstance()
        state = "webLoginWaiting"
        message = "请在 QQ 官方页面完成登录"
        val window = Dialog(activity, android.R.style.Theme_DeviceDefault_Light_NoActionBar)
        val layout = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        val info = TextView(activity).apply { text = message }
        val back = Button(activity).apply {
            text = "取消登录"
            setOnClickListener { close() }
        }
        val web = WebView(activity)
        browser = web
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(web, true)
        fun pageError(text: String) {
            state = "error"
            message = text
            info.text = text
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (trusted(uri)) return false
                // Only accept QQ schemes emitted by a trusted official page, never arbitrary intent URLs.
                // The official one-key login can be initiated from an iframe.
                if (browser === view && QqLoginNavigation.canOpenClient(view.url ?: "", uri.toString(), request.isForMainFrame)) {
                    try {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage("com.tencent.mobileqq"))
                        message = "请在 QQ 中确认，完成后返回拾忆"
                        info.text = message
                    } catch (_: android.content.ActivityNotFoundException) {
                        message = "未能打开 QQ，请在下方官方页面使用账号密码登录"
                        info.text = message
                    }
                }
                return true
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (browser === view && request.isForMainFrame) pageError("QQ 登录页暂时不可用，请稍后重新加载")
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                if (browser === view) pageError("QQ 登录页连接验证失败，请检查网络及系统时间")
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (browser === view && request.isForMainFrame) {
                    pageError("QQ 登录页加载失败，请检查网络后重试")
                }
            }
        }
        val actions = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        val retry = Button(activity).apply {
            text = "重新加载"
            setOnClickListener {
                state = "webLoginWaiting"
                message = "正在重新加载 QQ 登录页…"
                info.text = message
                web.loadUrl(loginUrl)
            }
        }
        actions.addView(back, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        actions.addView(retry, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        layout.addView(actions)
        layout.addView(info)
        layout.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        window.setContentView(layout)
        window.setOnDismissListener {
            if (dialog === window) {
                browser = null
                dialog = null
                web.stopLoading()
                web.destroy()
                cookies.removeAllCookies(null)
            }
            state = "webLoginCancelled"
            message = "登录已取消，可以重新打开登录页"
        }
        dialog = window
        window.show()
        window.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(layout) { view, insets ->
            val safe = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            view.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, ime.bottom))
            insets
        }
        androidx.core.view.ViewCompat.requestApplyInsets(layout)
        cookies.removeAllCookies {
            if (dialog !== window) return@removeAllCookies
            web.loadUrl(loginUrl)
        }
        invoke.resolve(JSObject().put("status", "webLoginOpened").put("message", message))
    }

    @Command
    fun poll(invoke: Invoke) {
        val result = JSObject().put("status", state).put("message", message)
        if (dialog != null && state != "error") {
            val cookies = CookieManager.getInstance().getCookie("https://h5.qzone.qq.com") ?: ""
            result.put("cookieHeader", cookies)
            result.put("userAgent", browser?.settings?.userAgentString ?: "")
        }
        invoke.resolve(result)
    }

    @Command
    fun cancel(invoke: Invoke) {
        close()
        // Login cookies must not survive logout/closing the flow in the WebView profile.
        CookieManager.getInstance().removeAllCookies { invoke.resolve(JSObject()) }
    }
}
