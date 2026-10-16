package top.ehre.qzonearchive

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** Bind the QQ browser handoff to one active login; never accept arbitrary deep links. */
object QqLoginCallback {
    private val hosts = setOf("ptlogin2.qq.com", "ssl.ptlogin2.qq.com", "xui.ptlogin2.qq.com",
        "ui.ptlogin2.qq.com", "ptlogin2.qzone.qq.com", "h5.qzone.qq.com", "user.qzone.qq.com", "i.qq.com")

    fun prepareLaunch(source: String, target: String, mainFrame: Boolean, nonce: String): String? {
        if (!nonce.matches(Regex("[a-f0-9]{32}")) || !QqLoginNavigation.canOpenClient(source, target, mainFrame)) return null
        val link = try { URI(target) } catch (_: Exception) { return null }
        // Other legacy intents have different return contracts; don't rewrite them.
        if (link.scheme != "wtloginmqq" || link.host != "ptlogin" || link.path != "/qlogin") return null
        val query = link.rawQuery.orEmpty().split('&').filter { part ->
            val name = try { URLDecoder.decode(part.substringBefore('='), "UTF-8") } catch (_: Exception) { return null }
            name != "schemacallback" && name != "encode_jump_url"
        }.filter { it.isNotEmpty() }.joinToString("&")
        val callback = URLEncoder.encode("qzonememory://qq-login/$nonce?url=", "UTF-8")
        return "wtloginmqq://ptlogin/qlogin?$query&schemacallback=$callback&encode_jump_url=1"
    }

    fun destination(callback: String, nonce: String?): String? {
        if (nonce == null || callback.length > 16384) return null
        val prefix = "qzonememory://qq-login/$nonce?url="
        if (!callback.startsWith(prefix)) return null
        val raw = callback.substring(prefix.length)
        // QQ versions return either the original URL or one URL-encoded value.
        val target = try { if (raw.startsWith("https://")) raw else URLDecoder.decode(raw, "UTF-8") }
            catch (_: Exception) { return null }
        val uri = try { URI(target) } catch (_: Exception) { return null }
        return target.takeIf { uri.scheme == "https" && uri.host in hosts && uri.rawUserInfo == null
            && uri.port in listOf(-1, 443) && uri.rawFragment == null }
    }
}
