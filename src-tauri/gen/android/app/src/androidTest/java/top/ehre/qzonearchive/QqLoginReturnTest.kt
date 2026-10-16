package top.ehre.qzonearchive

import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.test.core.app.ActivityScenario
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.URLEncoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class QqLoginReturnTest {
    @Test fun validatedReturnNavigatesTheLoginWebViewAndCannotBeReplayed() {
        val nonce = "0123456789abcdef0123456789abcdef"
        val target = "https://h5.qzone.qq.com/mqzone/index?fixture=return"
        val loaded = CountDownLatch(1)
        lateinit var plugin: QqLoginPlugin
        lateinit var web: WebView
        fun set(name: String, value: Any?) {
            QqLoginPlugin::class.java.getDeclaredField(name).apply { isAccessible = true }.set(plugin, value)
        }
        fun get(name: String): Any? = QqLoginPlugin::class.java.getDeclaredField(name)
            .apply { isAccessible = true }.get(plugin)
        ActivityScenario.launch(QqLoginTestActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                plugin = QqLoginPlugin(activity)
                web = WebView(activity)
                activity.setContentView(web)
                val callbackIntent = Intent(Intent.ACTION_VIEW, Uri.parse("qzonememory://qq-login/$nonce?url=" + URLEncoder.encode(target, "UTF-8")))
                    .setPackage(activity.packageName)
                val resolved = activity.packageManager.resolveActivity(callbackIntent, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)
                assertEquals(MainActivity::class.java.name, resolved?.activityInfo?.name)
                web.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                        WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream("<html>fixture</html>".toByteArray()))
                    override fun onPageFinished(view: WebView, url: String) { if (url == target) loaded.countDown() }
                }
                set("browser", web)
                set("callbackNonce", nonce)
                plugin.onNewIntent(Intent(Intent.ACTION_VIEW, Uri.parse("qzonememory://qq-login/wrong?url=$target")))
                assertEquals(nonce, get("callbackNonce"))
                plugin.onNewIntent(Intent(Intent.ACTION_VIEW, Uri.parse("qzonememory://qq-login/$nonce?url=" + URLEncoder.encode(target, "UTF-8"))))
                assertNull(get("callbackNonce"))
            }
            assertTrue("Callback did not reach the login WebView", loaded.await(15, TimeUnit.SECONDS))
            scenario.onActivity {
                plugin.onNewIntent(Intent(Intent.ACTION_VIEW, Uri.parse("qzonememory://qq-login/$nonce?url=https://h5.qzone.qq.com/replayed")))
                assertEquals(target, web.url)
                web.stopLoading()
                web.destroy()
                set("browser", null)
            }
        }
    }
}
