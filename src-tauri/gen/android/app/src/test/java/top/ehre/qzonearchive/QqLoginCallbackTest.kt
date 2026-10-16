package top.ehre.qzonearchive

import org.junit.Assert.*
import org.junit.Test
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

class QqLoginCallbackTest {
    private val nonce = "0123456789abcdef0123456789abcdef"
    private val page = "https://ui.ptlogin2.qq.com/cgi-bin/login"
    private val prefix = "qzonememory://qq-login/$nonce?url="

    @Test fun officialPayloadIsKeptAndBrowserReturnTargetIsReplaced() {
        val payload = "https%3A%2F%2Fssl.ptlogin2.qq.com%2Fjump%3Fexample%3Da%252Bb"
        val result = QqLoginCallback.prepareLaunch(page, "wtloginmqq://ptlogin/qlogin?p=$payload&schemacallback=googlechrome%3A%2F%2F&encode_jump_url=0", false, nonce)!!
        assertTrue(result.contains("p=$payload"))
        val pairs = URI(result).rawQuery.split('&')
        assertEquals(1, pairs.count { it.startsWith("schemacallback=") })
        assertEquals(prefix, URLDecoder.decode(pairs.single { it.startsWith("schemacallback=") }.substringAfter('='), "UTF-8"))
        assertTrue(result.endsWith("encode_jump_url=1"))
    }
    @Test fun rawAndEncodedReturnUrlsKeepTheirFullQuery() {
        val target = "https://ptlogin2.qzone.qq.com/check_sig?uin=12345&example=a%2Bb&second=two"
        assertEquals(target, QqLoginCallback.destination(prefix + target, nonce))
        assertEquals(target, QqLoginCallback.destination(prefix + URLEncoder.encode(target, "UTF-8"), nonce))
    }
    @Test fun unrelatedCancelledAndStaleReturnsAreRejected() {
        val target = "https://h5.qzone.qq.com/mqzone/index"
        assertNull(QqLoginCallback.destination(prefix + target, null))
        assertNull(QqLoginCallback.destination(prefix + target, "ffffffffffffffffffffffffffffffff"))
        assertNull(QqLoginCallback.destination("other://qq-login/$nonce?url=$target", nonce))
    }
    @Test fun unsafeReturnTargetsCannotBeLoadedWithLoginCredentials() {
        for (target in listOf("http://h5.qzone.qq.com/", "https://h5.qzone.qq.com.evil.example/",
            "https://evil.example/", "https://user@h5.qzone.qq.com/", "javascript:alert(1)",
            "https://h5.qzone.qq.com:8443/", "https%253A%252F%252Fevil.example", "%broken")) {
            assertNull(target, QqLoginCallback.destination(prefix + target, nonce))
        }
    }
    @Test fun onlyOfficialOneKeyLoginCanBeRewritten() {
        assertNull(QqLoginCallback.prepareLaunch("https://evil.example", "wtloginmqq://ptlogin/qlogin?p=x", true, nonce))
        assertNull(QqLoginCallback.prepareLaunch(page, "mqqapi://forward/open", true, nonce))
        assertNull(QqLoginCallback.prepareLaunch(page, "wtloginmqq://ptlogin/other", true, nonce))
        assertNull(QqLoginCallback.prepareLaunch(page, "wtloginmqq://ptlogin/qlogin?p=x", true, "bad"))
    }
}
