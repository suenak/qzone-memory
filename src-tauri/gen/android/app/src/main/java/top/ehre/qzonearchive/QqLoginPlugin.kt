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
import app.tauri.annotation.InvokeArg
import androidx.core.content.FileProvider
import android.provider.Settings
import java.io.File

@InvokeArg
class OpenUpdateArgs { lateinit var path: String }

@InvokeArg
class SaveSessionArgs { lateinit var session: String }

/** Native QQ login page; no JS bridge or credentials in frontend storage. */
@TauriPlugin
class QqLoginPlugin(private val activity: Activity) : Plugin(activity) {
    private val sessionVault = QqSessionVault(activity)

    @Command
    fun loadSession(invoke: Invoke) {
        try { invoke.resolve(JSObject().put("session", sessionVault.load() ?: org.json.JSONObject.NULL)) }
        catch (_: Exception) { invoke.reject("无法读取已保存的 QQ 登录，请重新登录") }
    }

    @Command
    fun saveSession(invoke: Invoke) {
        try {
            sessionVault.save(invoke.parseArgs(SaveSessionArgs::class.java).session)
            invoke.resolve(JSObject())
        } catch (_: Exception) { invoke.reject("无法安全保存 QQ 登录，本次会话仅在应用运行期间有效") }
    }

    @Command
    fun deleteSession(invoke: Invoke) {
        try { sessionVault.delete(); invoke.resolve(JSObject()) }
        catch (_: Exception) { invoke.reject("无法清除已保存的 QQ 登录") }
    }

    @Command
    fun openUpdate(invoke: Invoke) {
        try {
            val file = File(invoke.parseArgs(OpenUpdateArgs::class.java).path).canonicalFile
            val root = File(activity.cacheDir, "update-packages").canonicalFile
            if (!file.isFile || !file.path.startsWith(root.path + File.separator) || !file.name.endsWith(".apk")) {
                invoke.reject("安装包路径无效")
                return
            }
            val archive = activity.packageManager.getPackageArchiveInfo(file.path, 0)
            if (archive?.packageName != activity.packageName) {
                invoke.reject("安装包不属于拾忆，请重新下载")
                return
            }
            if (!activity.packageManager.canRequestPackageInstalls()) {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                invoke.reject("请允许安装应用，返回后再次点击打开安装包")
                return
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            invoke.resolve(JSObject())
        } catch (_: Exception) {
            invoke.reject("无法打开安装包")
        }
    }
    private var dialog: Dialog? = null
    private var browser: WebView? = null
    private var state = "webLoginCancelled"
    private var message = "登录已取消"
    private var callbackNonce: String? = null
    private var infoLabel: TextView? = null
    // Let Qzone generate the current mobile login URL and parameters.
    private val loginUrl = "https://h5.qzone.qq.com/mqzone/index"

    private fun trusted(uri: Uri): Boolean {
        val host = uri.host ?: return false
        return uri.scheme == "https" && (host == "qq.com" || host.endsWith(".qq.com")) && uri.userInfo == null
    }

    private fun close() {
        callbackNonce = null
        infoLabel = null
        dialog?.dismiss()
        browser?.stopLoading()
        browser?.destroy()
        browser = null
        dialog = null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val web = browser ?: return
        val destination = QqLoginCallback.destination(intent.dataString ?: return, callbackNonce) ?: return
        callbackNonce = null // A callback is single-use; cancellation/restarting also invalidates it.
        state = "webLoginWaiting"
        message = "QQ 已确认，正在完成空间登录…"
        infoLabel?.text = message
        web.loadUrl(destination)
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
        infoLabel = info
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
                        val bytes = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
                        val nonce = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
                        val launch = QqLoginCallback.prepareLaunch(view.url ?: "", uri.toString(), request.isForMainFrame, nonce)
                        if (launch == null) {
                            message = "当前 QQ 快捷登录方式暂不支持，请在官方页面使用账号密码登录"
                            info.text = message
                            return true
                        }
                        callbackNonce = nonce
                        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(launch)).setPackage("com.tencent.mobileqq"))
                        message = "请在 QQ 中确认，完成后返回拾忆"
                        info.text = message
                    } catch (_: android.content.ActivityNotFoundException) {
                        callbackNonce = null
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
                callbackNonce = null
                infoLabel = null
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
            val manager = CookieManager.getInstance()
            val cookies = QqLoginCookies.select(listOf(
                "https://user.qzone.qq.com", "https://i.qq.com", "https://h5.qzone.qq.com"
            ).map { manager.getCookie(it) ?: "" }) ?: ""
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
