package top.ehre.qzonearchive

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QqLoginNavigationTest {
    private val page = "https://ui.ptlogin2.qq.com/cgi-bin/login"
    private val quick = "wtloginmqq://ptlogin/qlogin?p=encoded-official-parameters"
    @Test fun officialOneKeyLoginMayUseAnIframe() {
        assertTrue(QqLoginNavigation.canOpenClient(page, quick, true))
        assertTrue(QqLoginNavigation.canOpenClient(page, quick, false))
    }
    @Test fun unrelatedOriginsAndCommandsCannotLaunchClients() {
        assertFalse(QqLoginNavigation.canOpenClient("https://evil.example", quick, true))
        assertFalse(QqLoginNavigation.canOpenClient("https://ui.ptlogin2.qq.com.evil.example", quick, true))
        assertFalse(QqLoginNavigation.canOpenClient("http://ui.ptlogin2.qq.com", quick, true))
        assertFalse(QqLoginNavigation.canOpenClient("https://user@ui.ptlogin2.qq.com", quick, true))
        assertFalse(QqLoginNavigation.canOpenClient(page, "wtloginmqq://other/qlogin", true))
        assertFalse(QqLoginNavigation.canOpenClient(page, "wtloginmqq://ptlogin/other", false))
        assertFalse(QqLoginNavigation.canOpenClient(page, "intent://anything", true))
        assertFalse(QqLoginNavigation.canOpenClient(page, "mqqapi://forward/open", false))
        assertFalse(QqLoginNavigation.canOpenClient(page, "not a uri", true))
    }
    @Test fun officialMainFrameCanUseLegacyQqLinks() {
        assertTrue(QqLoginNavigation.canOpenClient(page, "mqqapi://forward/open", true))
    }
}
