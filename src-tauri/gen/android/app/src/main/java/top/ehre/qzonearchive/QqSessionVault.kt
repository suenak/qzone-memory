package top.ehre.qzonearchive

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only ciphertext lives on disk; the non-exportable AES key stays in Android Keystore. */
internal class QqSessionVault(context: Context, namespace: String = "qq-session") {
    init { require(namespace.matches(Regex("[a-z0-9-]{1,64}"))) }
    private val file = AtomicFile(File(context.noBackupFilesDir, "$namespace.enc"))
    private val alias = "top.ehre.qzonearchive.$namespace.v1"
    private val aad = alias.toByteArray(Charsets.UTF_8)

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create) { "Session encryption key unavailable" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }

    @Synchronized
    fun save(session: String) {
        val plain = session.toByteArray(Charsets.UTF_8)
        require(plain.isNotEmpty() && plain.size <= 65536)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key(true))
            updateAAD(aad)
        }
        check(cipher.iv.size == 12)
        val payload = byteArrayOf(1) + cipher.iv + cipher.doFinal(plain)
        val stream = file.startWrite()
        try {
            stream.write(payload)
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    @Synchronized
    fun load(): String? {
        val stream = try { file.openRead() } catch (_: java.io.FileNotFoundException) { return null }
        val payload = stream.use { input ->
            val buffer = ByteArray(65566)
            var size = 0
            while (size < buffer.size) {
                val count = input.read(buffer, size, buffer.size - size)
                if (count < 0) break
                size += count
            }
            buffer.copyOf(size)
        }
        require(payload.size in 30..65565 && payload[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, payload.copyOfRange(1, 13)))
            updateAAD(aad)
        }
        return String(cipher.doFinal(payload.copyOfRange(13, payload.size)), Charsets.UTF_8)
    }

    @Synchronized
    fun delete() {
        file.delete()
        check(!file.baseFile.exists()) { "Session could not be removed" }
    }
}
