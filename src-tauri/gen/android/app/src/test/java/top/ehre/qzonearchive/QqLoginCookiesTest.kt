package top.ehre.qzonearchive

import org.junit.Assert.*
import org.junit.Test

class QqLoginCookiesTest {
    @Test fun desktopScopedCredentialsCanCompleteAMobileLogin() {
        val result = QqLoginCookies.select(listOf("", "p_uin=o0012345; p_skey=fixture-key; tracking=discard", "uin=o0012345"))!!
        assertTrue(result.contains("p_skey=fixture-key"))
        assertFalse(result.contains("tracking"))
    }
    @Test fun partialHeadersFromDifferentOriginsAreNotCombined() {
        assertNull(QqLoginCookies.select(listOf("p_uin=o0012345", "p_skey=fixture-key")))
        assertNull(QqLoginCookies.select(listOf("p_uin=o0012345; uin=o0067890; p_skey=fixture-key")))
    }
    @Test fun malformedAndEmptyCookiesAreNotSuccessfulLogins() {
        for (header in listOf("p_uin=o000; p_skey=x", "p_uin=bad; p_skey=x", "p_uin=o12345; p_skey=", "uin=o12345")) {
            assertNull(header, QqLoginCookies.select(listOf(header)))
        }
        assertNotNull(QqLoginCookies.select(listOf("p_uin=o0012345; uin=o12345; p_skey=fixture=key")))
    }
}
