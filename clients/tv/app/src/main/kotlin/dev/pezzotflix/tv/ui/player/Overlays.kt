package dev.pezzotflix.tv.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import dev.pezzotflix.api.models.SessionTrack
import dev.pezzotflix.tv.player.PlayerController
import dev.pezzotflix.tv.player.PlayerController.Phase
import dev.pezzotflix.tv.ui.InitialFocus
import dev.pezzotflix.tv.ui.PzfButton
import dev.pezzotflix.tv.ui.PzfColors
import dev.pezzotflix.tv.ui.Txt
import dev.pezzotflix.tv.ui.formatClock
import dev.pezzotflix.tv.ui.trackLabel
import kotlinx.coroutines.delay

private val Scrim = Color(0xCC000000)

/** Title, position, and the buttons; the first one (play/pause) takes the focus. */
@Composable
fun BoxScope.Controls(
    title: String,
    state: PlayerController.State,
    focus: FocusRequester,
    onTogglePlay: () -> Unit,
    onSeek: (Long) -> Unit,
    onPanel: (Panel) -> Unit,
) {
    Column(
        Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Scrim, Color(0xEE000000))))
            .padding(horizontal = 48.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(title, style = MaterialTheme.typography.headlineMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val duration = state.durationMs.coerceAtLeast(1)
        Box(Modifier.fillMaxWidth().height(6.dp).background(Color(0x55FFFFFF), RoundedCornerShape(3.dp))) {
            Box(
                Modifier.fillMaxHeight().fillMaxWidth((state.bufferedMs.toFloat() / duration).coerceIn(0f, 1f))
                    .background(Color(0x88FFFFFF), RoundedCornerShape(3.dp)),
            )
            Box(
                Modifier.fillMaxHeight().fillMaxWidth((state.positionMs.toFloat() / duration).coerceIn(0f, 1f))
                    .background(PzfColors.Accent, RoundedCornerShape(3.dp)),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${formatClock(state.positionMs)} / ${formatClock(state.durationMs)}", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.width(16.dp))
            if (state.ended) Text(Txt.PLAYER_ENDED, style = MaterialTheme.typography.titleMedium, color = PzfColors.Muted)
            if (state.buffering) Text(Txt.PLAYER_BUFFERING, style = MaterialTheme.typography.titleMedium, color = PzfColors.Muted)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            PzfButton(
                if (state.playing) Txt.PLAYER_PAUSE else Txt.PLAYER_PLAY,
                onTogglePlay,
                Modifier.focusRequester(focus).testTag("play-pause"),
                primary = true,
            )
            PzfButton(Txt.PLAYER_BACK10, { onSeek(-SKIP_MS) })
            PzfButton(Txt.PLAYER_FORWARD10, { onSeek(SKIP_MS) })
            PzfButton(Txt.PLAYER_AUDIO, { onPanel(Panel.AUDIO) }, Modifier.testTag("audio"))
            PzfButton(Txt.PLAYER_SUBTITLES, { onPanel(Panel.SUBTITLES) }, Modifier.testTag("subtitles"))
            PzfButton(Txt.PLAYER_INFO, { onPanel(Panel.INFO) }, Modifier.testTag("info"))
        }
    }
}

/** Audio and subtitle choice (always through ChangeTracks), or the technical information. */
@Composable
fun BoxScope.SidePanel(panel: Panel, state: PlayerController.State, onAudio: (String) -> Unit, onSubtitle: (String?) -> Unit) {
    val session = state.session ?: return
    val first = remember { FocusRequester() }
    Column(
        Modifier
            .align(Alignment.CenterEnd)
            .fillMaxHeight()
            .width(460.dp)
            .background(Color(0xF0141418))
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (panel) {
            Panel.AUDIO -> {
                Text(Txt.PLAYER_AUDIO, style = MaterialTheme.typography.headlineMedium)
                val tracks = session.tracks.audio
                val focusIndex = tracks.indexOfFirst { it.selected }.coerceAtLeast(0)
                LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(tracks.size) { i ->
                        val t = tracks[i]
                        TrackRow(trackLabel(t), t.selected, { onAudio(t.id) }, if (i == focusIndex) Modifier.focusRequester(first) else Modifier)
                    }
                }
            }
            Panel.SUBTITLES -> {
                Text(Txt.PLAYER_SUBTITLES, style = MaterialTheme.typography.headlineMedium)
                val tracks = session.tracks.subtitles
                val selected = tracks.indexOfFirst { it.selected }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    item {
                        TrackRow(Txt.TRACK_NONE, selected < 0, { onSubtitle(null) }, if (selected < 0) Modifier.focusRequester(first) else Modifier)
                    }
                    items(tracks.size) { i ->
                        val t = tracks[i]
                        val label = trackLabel(t) + if (t.availability == SessionTrack.Availability.growing) " · ${Txt.TRACK_PREPARING}" else ""
                        TrackRow(label, t.selected, { onSubtitle(t.id) }, if (i == selected) Modifier.focusRequester(first) else Modifier)
                    }
                }
            }
            Panel.INFO -> {
                Text(Txt.PLAYER_INFO, style = MaterialTheme.typography.headlineMedium)
                val lines = buildList {
                    add("${Txt.INFO_MODE}: ${Txt.mode(session.mode)}")
                    session.reasons.forEach { add("• $it") }
                    add("${Txt.INFO_PROTOCOL}: ${session.stream.protocol.value}")
                    session.stream.mimeType?.let { add("${Txt.INFO_MIME}: $it") }
                    state.capabilities?.device?.model?.let { add("${Txt.INFO_DEVICE}: $it") }
                    val failures = state.failures.joinToString("; ") { "${it.error} (${it.suspect ?: "—"})" }.ifEmpty { Txt.INFO_NONE }
                    add("${Txt.INFO_FAILURES}: $failures")
                }
                // A focusable list: the panel has to hold the focus, and long reasons scroll.
                LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(lines.size) { i ->
                        TrackRow(lines[i], false, {}, if (i == 0) Modifier.focusRequester(first) else Modifier)
                    }
                }
            }
        }
    }
    InitialFocus(first, panel)
}

@Composable
private fun TrackRow(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    ListItem(
        selected = selected,
        onClick = onClick,
        headlineContent = { Text(label, style = MaterialTheme.typography.bodyLarge) },
        leadingContent = { Text(if (selected) "✓" else " ", style = MaterialTheme.typography.bodyLarge) },
        modifier = modifier,
    )
}

/** The player's phases as the web's StatusOverlay: busy texts, dialogs with "Riprova" and "Indietro", notices. */
@Composable
fun BoxScope.StatusOverlay(
    state: PlayerController.State,
    onRetry: () -> Unit,
    onTerminate: (String) -> Unit,
    onExit: () -> Unit,
    onDismissNotice: () -> Unit,
) {
    when (state.phase) {
        Phase.IDLE, Phase.STARTING -> BusyText(Txt.PLAYER_STARTING)
        Phase.PREPARING -> BusyText(Txt.PLAYER_PREPARING)
        Phase.REPLANNING -> BusyText(Txt.PLAYER_REPLANNING)
        Phase.PLAYING -> {
            state.notice?.let { Notice(it, onDismissNotice) }
            if (state.buffering) BusyText(Txt.PLAYER_BUFFERING)
        }
        Phase.FAILED -> Dialog(
            Txt.PLAYER_FAILED_TITLE,
            listOf(
                if (state.error?.code == "STREAM_FAILED") Txt.PLAYER_STREAM_FAILED
                else Txt.playerFailedAttempts(minOf(state.attempts, PlayerController.MAX_AUTOMATIC_ATTEMPTS)),
            ) + reasons(state),
            listOf(Txt.RETRY to onRetry, Txt.BACK to onExit),
        )
        Phase.NO_PLAN -> Dialog(
            Txt.PLAYER_NO_PLAN_TITLE,
            listOfNotNull(
                if (state.error?.code == "CLIENT_UNSUPPORTED_PROTOCOL") Txt.playerNoPlanProtocol(state.error?.detail.orEmpty()) else state.error?.detail,
            ) + reasons(state),
            listOf(Txt.BACK to onExit),
        )
        Phase.SESSION_LIMIT -> Dialog(
            Txt.PLAYER_SESSION_LIMIT_TITLE,
            listOfNotNull(Txt.PLAYER_SESSION_LIMIT_TEXT, state.error?.detail.takeIf { state.activeSessions.isEmpty() }),
            state.activeSessions.map { s -> Txt.playerStopOther(s.itemTitle, s.profileName) to { onTerminate(s.sessionId) } } + (Txt.BACK to onExit),
        )
        Phase.EXPIRED -> Dialog(
            Txt.PLAYER_EXPIRED_TITLE,
            listOf(Txt.PLAYER_EXPIRED_TEXT),
            listOf(Txt.playerResumeFrom(state.positionMs) to onRetry, Txt.BACK to onExit),
        )
        Phase.TERMINATED -> Dialog(
            Txt.PLAYER_TERMINATED_TITLE,
            listOfNotNull(Txt.PLAYER_TERMINATED_TEXT, state.terminatedReason?.let(Txt::terminatedReason)),
            // A title that left the library cannot be resumed.
            listOfNotNull(
                (Txt.playerResumeFrom(state.positionMs) to onRetry).takeIf { state.terminatedReason != "item_removed" },
                Txt.BACK to onExit,
            ),
        )
        Phase.NETWORK -> Dialog(Txt.PLAYER_NETWORK_TITLE, listOf(Txt.ERROR_NETWORK), listOf(Txt.RETRY to onRetry, Txt.BACK to onExit))
        Phase.UNAVAILABLE -> Dialog(Txt.PLAYER_ERROR_TITLE, listOf(Txt.ERROR_MEDIA), listOf(Txt.RETRY to onRetry, Txt.BACK to onExit))
        Phase.ERROR -> {
            val code = state.error?.code
            // The message is chosen by code; the server's (English) detail stays as a technical line under the code.
            val text = when (code) {
                "STREAM_PREPARING" -> Txt.PLAYER_PREPARING_TIMEOUT
                "MEDIA_UNAVAILABLE" -> Txt.ERROR_MEDIA
                "NOT_FOUND" -> Txt.ERROR_NOT_FOUND
                "NETWORK" -> Txt.ERROR_NETWORK
                else -> Txt.ERROR_GENERIC
            }
            val technical = code?.let { c -> state.error?.detail?.let { "${Txt.errorCode(c)} · $it" } ?: Txt.errorCode(c) }
            Dialog(Txt.PLAYER_ERROR_TITLE, listOfNotNull(text, technical), listOf(Txt.RETRY to onRetry, Txt.BACK to onExit))
        }
        Phase.CLOSED -> Unit
    }
}

private fun reasons(state: PlayerController.State): List<String> {
    val out = mutableListOf<String>()
    val reasons = state.session?.reasons.orEmpty()
    if (reasons.isNotEmpty()) out += "${Txt.PLAYER_REASONS}: " + reasons.joinToString("; ")
    state.failures.lastOrNull()?.let { out += Txt.playerLastFailure(it.error, it.suspect) }
    return out
}

@Composable
private fun BoxScope.BusyText(text: String) {
    Box(
        Modifier.align(Alignment.Center).background(Scrim, RoundedCornerShape(12.dp)).padding(horizontal = 32.dp, vertical = 20.dp),
    ) {
        Text(text, style = MaterialTheme.typography.titleLarge)
    }
}

@Composable
private fun BoxScope.Dialog(title: String, lines: List<String>, actions: List<Pair<String, () -> Unit>>) {
    val first = remember { FocusRequester() }
    Box(Modifier.fillMaxSize().background(Scrim), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 820.dp).background(Color(0xFF1C1C21), RoundedCornerShape(12.dp)).padding(32.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(title, style = MaterialTheme.typography.headlineMedium)
            lines.forEach { Text(it, style = MaterialTheme.typography.bodyLarge) }
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                actions.forEachIndexed { i, (label, action) ->
                    PzfButton(label, action, if (i == 0) Modifier.focusRequester(first).testTag("dialog-primary") else Modifier, primary = i == 0)
                }
            }
        }
    }
    InitialFocus(first, title)
}

@Composable
private fun BoxScope.Notice(notice: PlayerController.Notice, onDismiss: () -> Unit) {
    val text = when (notice) {
        is PlayerController.Notice.ChangeRefused -> listOfNotNull(Txt.PLAYER_NOTICE_422, notice.detail).joinToString("\n")
        PlayerController.Notice.ImageSubtitleNotRendered -> Txt.PLAYER_NOTICE_IMAGE_SUBS
    }
    LaunchedEffect(notice) {
        delay(NOTICE_MS)
        onDismiss()
    }
    Box(
        Modifier.align(Alignment.TopCenter).padding(top = 32.dp).widthIn(max = 820.dp)
            .background(Scrim, RoundedCornerShape(12.dp)).padding(horizontal = 24.dp, vertical = 16.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}

private const val NOTICE_MS = 8_000L
