package top.ehre.qzonearchive

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import java.io.File

class QqSessionVaultTest {
    // Separate file and key alias: never touch an app's real saved session.
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val file get() = File(context.noBackupFilesDir, "qq-session-test-vault.enc")
    private fun newVault() = QqSessionVault(context, "qq-session-test-vault")
    @Before fun cleanBefore() { newVault().delete() }
    @After fun cleanAfter() { newVault().delete() }

    @Test fun restoresAcrossInstancesWithoutPlaintextOnDisk() {
        val sample = "{\"cookies\":{\"p_skey\":\"fixture-session-value\"}}"
        newVault().save(sample)
        assertEquals(sample, newVault().load())
        assertFalse(String(file.readBytes(), Charsets.ISO_8859_1).contains("fixture-session-value"))
    }
    @Test fun usesFreshNoncesAndReplacesOldCredentials() {
        val vault = newVault()
        vault.save("first fixture session")
        val first = file.readBytes()
        vault.save("first fixture session")
        assertFalse(first.contentEquals(file.readBytes()))
        vault.save("replacement fixture session")
        assertEquals("replacement fixture session", newVault().load())
    }
    @Test fun tamperingIsRejectedAndLogoutRemovesTheSavedValue() {
        val vault = newVault()
        vault.save("fixture session")
        val bytes = file.readBytes()
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        file.writeBytes(bytes)
        try { vault.load(); fail("Tampered credentials were accepted") } catch (_: java.security.GeneralSecurityException) { }
        vault.delete()
        assertNull(newVault().load())
    }
}


class QqSessionPersistenceTest {
    @Test fun persistedValueSurvivesProcessRestart() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vault = QqSessionVault(context, "qq-session-process-test")
        val sample = "fixture-for-process-restart"
        val phase = InstrumentationRegistry.getArguments().getString("vaultPhase")
        org.junit.Assume.assumeTrue("Run write and read phases in separate processes", phase in listOf("write", "read"))
        when (phase) {
            "write" -> { vault.delete(); vault.save(sample); assertEquals(sample, vault.load()) }
            "read" -> { assertEquals(sample, vault.load()); vault.delete(); assertNull(vault.load()) }
            else -> fail("An explicit write/read test phase is required")
        }
    }
}
