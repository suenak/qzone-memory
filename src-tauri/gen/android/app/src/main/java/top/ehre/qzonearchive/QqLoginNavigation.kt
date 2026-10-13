package top.ehre.qzonearchive

import java.net.URI

/** Only official login pages may launch the QQ client, including their one-key iframe. */
object QqLoginNavigation {
    fun canOpenClient(source: String, target: String, mainFrame: Boolean): Boolean {
        return try {
            val page = URI(source)
            val link = URI(target)
            val trusted = page.scheme == "https" && page.rawUserInfo == null && page.host in setOf(
                "ui.ptlogin2.qq.com", "xui.ptlogin2.qq.com", "ssl.ptlogin2.qq.com", "h5.qzone.qq.com"
            )
            val quick = link.scheme == "wtloginmqq" && link.host == "ptlogin" && link.path == "/qlogin" && link.rawUserInfo == null
            val legacy = mainFrame && link.scheme in setOf("mqq", "mqqapi", "mqqopensdkapi") && link.rawUserInfo == null
            trusted && (quick || legacy)
        } catch (_: Exception) { false }
    }
}
