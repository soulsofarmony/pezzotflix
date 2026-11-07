package dev.pezzotflix.tv.ui

import dev.pezzotflix.api.models.DeliveryMode
import dev.pezzotflix.api.models.SessionTrack
import dev.pezzotflix.tv.api.ApiException
import dev.pezzotflix.tv.player.tracks.TrackMatcher
import java.util.Locale

/** Italian UI text, the same wording as the web client's catalog (clients/web/src/i18n/it.ts). One language: no resources. */
object Txt {
    const val APP = "Pezzotflix"
    const val LOADING = "Caricamento…"
    const val RETRY = "Riprova"
    const val BACK = "Indietro"
    const val CLOSE = "Chiudi"

    const val SERVER_TITLE = "Indirizzo del server"
    const val SERVER_HINT = "Scrivi l'indirizzo del server Pezzotflix nella rete di casa, per esempio 192.168.1.10:8080."
    const val SERVER_PLACEHOLDER = "192.168.1.10:8080"
    const val SERVER_CONNECT = "Collegati"
    const val SERVER_INVALID = "Indirizzo non valido: scrivi host e porta, per esempio 192.168.1.10:8080."
    const val SERVER_CHANGE = "Cambia server"

    const val PROFILES_TITLE = "Chi guarda?"
    const val PROFILES_EMPTY = "Non ci sono ancora profili. Creane uno dall'app web, poi torna qui."
    const val SWITCH_PROFILE = "Cambia profilo"

    const val HOME_EMPTY = "La libreria è vuota. Aggiungi dei film alla cartella della libreria: compariranno qui dopo la scansione."
    const val SERVER_UNREACHABLE_TITLE = "Il server non risponde"
    fun serverAddress(address: String) = "Server: $address"

    const val SEARCH = "Cerca"
    const val SEARCH_PLACEHOLDER = "Cerca un film, una serie, un documentario…"
    const val SEARCH_HINT = "Scrivi un titolo, anche quello originale."
    fun searchEmpty(query: String) = "Nessun risultato per «$query»."
    fun searchResults(count: Int) = if (count == 1) "1 risultato" else "$count risultati"

    const val WATCHLIST = "La mia lista"
    const val LIST_EMPTY = "Nessun titolo."

    const val ERROR_GENERIC = "Qualcosa è andato storto."
    const val ERROR_NETWORK = "Il server non risponde. Controlla la connessione."
    const val ERROR_NOT_FOUND = "Non trovato."
    const val ERROR_UNAUTHORIZED = "Scegli di nuovo il profilo."
    const val ERROR_SERVICE = "Il servizio non risponde in questo momento."
    const val ERROR_MEDIA = "Il file non è raggiungibile: il disco o la cartella potrebbero essere scollegati."

    const val KIND_MOVIE = "Film"
    const val KIND_SERIES = "Serie"
    const val KIND_SEASON = "Stagione"
    const val KIND_EPISODE = "Episodio"
    const val KIND_EXTRA = "Extra"
    const val KIND_DOCUMENTARY = "Documentario"

    const val ITEM_UNAVAILABLE = "Non disponibile: il file non è raggiungibile."
    const val ITEM_UNAVAILABLE_SHORT = "Non disponibile"
    const val ITEM_PROVISIONAL = "In attesa di identificazione: il titolo viene dal nome del file."
    const val ITEM_PROVISIONAL_SHORT = "In attesa"
    const val ITEM_PLAY = "Riproduci"
    const val ITEM_FROM_START = "Dall’inizio"
    const val ITEM_NEXT_UP = "Prossimo episodio"
    const val ITEM_NO_NEXT_UP = "Nessun episodio da guardare."
    const val ITEM_NO_OVERVIEW = "Nessuna trama disponibile."
    const val ITEM_WATCHED = "Visto"
    const val ITEM_MARK_WATCHED = "Segna come visto"
    const val ITEM_MARK_UNWATCHED = "Segna come da vedere"
    const val ITEM_WATCHLIST_ADD = "Aggiungi alla mia lista"
    const val ITEM_WATCHLIST_REMOVE = "Togli dalla mia lista"
    const val ITEM_CLEAR_PROGRESS = "Togli da Continua a guardare"
    const val ITEM_SEASONS = "Stagioni"
    const val ITEM_EPISODES = "Episodi"
    const val ITEM_SPECIALS = "Speciali"
    const val ITEM_EXTRAS = "Extra"
    const val ITEM_DETAILS = "Dettagli"
    fun itemSeason(number: Long) = "Stagione $number"
    fun itemProgress(percent: Long) = "Visto al $percent%"
    fun itemResume(ms: Long) = "Riprendi da ${formatClock(ms)}"
    fun playEpisode(season: Long, episode: Long) = "Riproduci S$season E$episode"
    fun episodeCode(season: Long, episode: Long) = "S${season}E$episode"

    const val TRACK_UNKNOWN_LANGUAGE = "Lingua sconosciuta"
    const val TRACK_NONE = "Nessuno"
    const val TRACK_FORCED = "forzati"
    const val TRACK_SDH = "per non udenti"
    const val TRACK_COMMENTARY = "commento"
    const val TRACK_PREPARING = "in preparazione"

    const val PLAYER_PLAY = "Riproduci"
    const val PLAYER_PAUSE = "Pausa"
    const val PLAYER_AUDIO = "Audio"
    const val PLAYER_SUBTITLES = "Sottotitoli"
    const val PLAYER_INFO = "Informazioni tecniche"
    const val PLAYER_BACK10 = "−10 s"
    const val PLAYER_FORWARD10 = "+10 s"
    const val PLAYER_STARTING = "Avvio…"
    const val PLAYER_PREPARING = "In preparazione… il server sta indicizzando il file."
    const val PLAYER_REPLANNING = "Cambio di modalità in corso…"
    const val PLAYER_BUFFERING = "Caricamento…"
    const val PLAYER_FAILED_TITLE = "Non riesco a riprodurre questo titolo"
    fun playerFailedAttempts(count: Int) = "Ho provato $count volte a cambiare modalità senza riuscirci."
    const val PLAYER_REASONS = "Motivi"
    fun playerLastFailure(error: String, suspect: String?) = "Ultimo errore: $error (dimensione sospetta: ${suspect ?: "—"})"
    const val PLAYER_NO_PLAN_TITLE = "Nessuna modalità di riproduzione possibile"
    fun playerNoPlanProtocol(protocol: String) = "Il server ha proposto un protocollo che questo client non conosce ($protocol)."
    const val PLAYER_SESSION_LIMIT_TITLE = "C’è già una riproduzione in corso"
    const val PLAYER_SESSION_LIMIT_TEXT = "Il server permette una sola riproduzione alla volta. Puoi interrompere l’altra e guardare qui."
    fun playerStopOther(title: String?, profile: String?) =
        if (profile != null) "Interrompi «${title ?: "—"}» ($profile)" else "Interrompi «${title ?: "—"}»"
    const val PLAYER_EXPIRED_TITLE = "La sessione è scaduta"
    const val PLAYER_EXPIRED_TEXT = "Il server ha chiuso la riproduzione per inattività."
    fun playerResumeFrom(ms: Long) = "Riprendi da ${formatClock(ms)}"
    const val PLAYER_TERMINATED_TITLE = "Riproduzione interrotta"
    const val PLAYER_TERMINATED_TEXT = "Il server ha chiuso questa riproduzione."
    fun terminatedReason(reason: String) = when (reason) {
        "expired" -> "Il server non riceveva più segnali da questo dispositivo e ha chiuso la sessione."
        "terminated" -> "È stata interrotta da un altro dispositivo o profilo, per liberare il posto."
        "failed" -> "La riproduzione non è riuscita e non restano altre modalità da provare."
        "item_removed" -> "Il titolo è stato tolto dalla libreria."
        else -> "Motivo: $reason"
    }
    const val PLAYER_NETWORK_TITLE = "Connessione persa"
    const val PLAYER_PREPARING_TIMEOUT = "Il file è ancora in preparazione. Riprova fra poco."
    const val PLAYER_ERROR_TITLE = "Errore di riproduzione"
    const val PLAYER_NOTICE_422 = "Questa scelta non si può riprodurre su questo dispositivo: resta quella attuale."
    const val PLAYER_SUBTITLES_PREPARING = "Sottotitoli in preparazione…"
    const val PLAYER_STREAM_FAILED = "Il server non è riuscito a preparare lo stream, anche dopo i tentativi automatici."
    const val PLAYER_ENDED = "Fine"
    fun errorCode(code: String) = "Codice: $code"

    const val INFO_MODE = "Modalità"
    const val INFO_PROTOCOL = "Protocollo"
    const val INFO_MIME = "Tipo MIME"
    const val INFO_DEVICE = "Dispositivo"
    const val INFO_FAILURES = "Fallimenti"
    const val INFO_NONE = "nessuno"

    fun mode(mode: DeliveryMode): String = when (mode.value) {
        "direct_play" -> "Riproduzione diretta"
        "direct_stream" -> "Stream diretto (remux)"
        "transcode" -> "Transcodifica"
        else -> mode.value
    }

    /** Generic message by problem code and status (ADR 0004: by code, never by text). */
    fun error(e: Throwable?): String {
        if (e !is ApiException) return ERROR_GENERIC
        return when (e.code) {
            "NETWORK" -> ERROR_NETWORK
            "NOT_FOUND" -> ERROR_NOT_FOUND
            "UNAUTHORIZED" -> ERROR_UNAUTHORIZED
            // The gateway's answer while the Video Service is down: no catalog call answers it otherwise.
            "MEDIA_UNAVAILABLE" -> ERROR_SERVICE
            else -> when {
                e.status == 503 -> ERROR_SERVICE
                e.status == 404 -> ERROR_NOT_FOUND
                else -> ERROR_GENERIC
            }
        }
    }
}

/** Player clock: "1:47:23" or "47:23". */
fun formatClock(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/** "1 h 47 min", "47 min", "25 s" (as the web client: under half a minute in seconds). */
fun formatDuration(ms: Long): String {
    val totalMin = Math.round(ms / 60_000.0)
    if (totalMin < 1) return "${(ms / 1000).coerceAtLeast(0)} s"
    val h = totalMin / 60
    val m = totalMin % 60
    return when {
        h == 0L -> "$m min"
        m == 0L -> "$h h"
        else -> "$h h $m min"
    }
}

/** "ita" → "Italiano"; unknown codes come back as they are, "und" and null as null. */
fun languageName(code: String?): String? {
    val iso = TrackMatcher.normalizeLanguage(code) ?: return null
    val name = Locale.forLanguageTag(iso).getDisplayLanguage(Locale.ITALIAN)
    if (name.isBlank() || name.equals(iso, ignoreCase = true)) return code
    return name.replaceFirstChar { it.titlecase(Locale.ITALIAN) }
}

private val CODEC_NAMES = mapOf(
    "truehd" to "TrueHD", "dts" to "DTS", "dtshd" to "DTS-HD", "dts-hd" to "DTS-HD", "eac3" to "E-AC-3", "ac3" to "AC-3",
    "aac" to "AAC", "flac" to "FLAC", "opus" to "Opus", "pcm" to "PCM", "mp3" to "MP3", "h264" to "H.264", "hevc" to "HEVC",
    "av1" to "AV1", "vp9" to "VP9", "hdmv_pgs_subtitle" to "PGS", "pgs" to "PGS", "subrip" to "SRT", "srt" to "SRT",
    "ass" to "ASS", "ssa" to "SSA", "webvtt" to "WebVTT", "mov_text" to "Timed Text", "dvd_subtitle" to "VobSub",
    "dvb_subtitle" to "DVB",
)

fun codecName(codec: String?): String? = codec?.let { CODEC_NAMES[it.lowercase()] ?: it.uppercase() }

fun channelLabel(channels: Long?, layout: String?): String? {
    if (layout != null && Regex("^\\d\\.\\d").containsMatchIn(layout)) return layout.replace(Regex("\\(.*\\)$"), "")
    return when (channels) {
        null, 0L -> null
        1L -> "1.0"
        2L -> "2.0"
        6L -> "5.1"
        8L -> "7.1"
        else -> "$channels ch"
    }
}

private val OBJECT_AUDIO = mapOf("atmos" to "Atmos", "dtsx" to "DTS:X")

/** "Italiano · TrueHD 7.1 Atmos" / "Inglese · PGS · forzati" (as the web client's trackLabel). */
fun trackLabel(t: SessionTrack): String {
    val parts = mutableListOf(languageName(t.language) ?: Txt.TRACK_UNKNOWN_LANGUAGE)
    val codec = codecName(t.codec)
    if (t.type == SessionTrack.Type.audio) {
        val obj = t.objectAudio?.let { OBJECT_AUDIO[it.lowercase()] ?: it }
        val tech = listOfNotNull(codec, channelLabel(t.channels, t.channelLayout), obj).joinToString(" ")
        if (tech.isNotEmpty()) parts += tech
    } else if (codec != null) {
        parts += codec
    }
    val flags = listOfNotNull(
        Txt.TRACK_FORCED.takeIf { t.forced == true },
        Txt.TRACK_SDH.takeIf { t.sdh == true },
        Txt.TRACK_COMMENTARY.takeIf { t.commentary == true },
    )
    if (flags.isNotEmpty()) parts += flags.joinToString(", ")
    val title = t.title
    if (title != null && parts.none { it.equals(title, ignoreCase = true) }) parts += "«$title»"
    return parts.joinToString(" · ")
}
