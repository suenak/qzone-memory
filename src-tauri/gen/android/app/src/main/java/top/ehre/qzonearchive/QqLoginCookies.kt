package top.ehre.qzonearchive

object QqLoginCookies {
    private val names = listOf("uin", "skey", "p_uin", "pt4_token", "p_skey", "pt2gguin")
    fun select(headers: List<String>): String? {
        for (header in headers) {
            val cookies = header.split(';').mapNotNull {
                val pair = it.trim().split('=', limit = 2)
                if (pair.size == 2 && pair[0] in names && pair[1].isNotBlank()) pair[0] to pair[1] else null
            }.toMap()
            if (cookies["p_skey"].isNullOrBlank()) continue
            val uin = cookies["p_uin"] ?: cookies["uin"] ?: continue
            fun normalize(value: String) = value.removePrefix("o").trimStart('0')
            val normalized = normalize(uin)
            if (normalized.isEmpty() || !normalized.all { it in '0'..'9' }) continue
            if (cookies["uin"]?.let { normalize(it) != normalized } == true) continue
            return names.mapNotNull { name -> cookies[name]?.let { "$name=$it" } }.joinToString("; ")
        }
        return null
    }
}
