package dev.pezzotflix.tv.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import dev.pezzotflix.api.models.Profile
import dev.pezzotflix.tv.AppContainer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

class ProfilesViewModel(private val container: AppContainer) : LoadViewModel<List<Profile>>() {
    var selectError by mutableStateOf<String?>(null)
        private set
    var selecting by mutableStateOf(false)
        private set

    init {
        reload()
    }

    override suspend fun fetch(): List<Profile> = api().listProfiles()

    private fun api() = container.connection?.api ?: error("no server")

    /** SelectProfile: the token is remembered on the TV, then the events start. */
    fun select(profile: Profile, onSelected: () -> Unit) {
        if (selecting) return
        selecting = true
        selectError = null
        viewModelScope.launch {
            try {
                val s = api().selectProfile(profile.id)
                container.prefs.saveProfile(s.profileToken, s.profile.id, s.profile.name)
                onSelected()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                selectError = Txt.error(e)
            } finally {
                selecting = false
            }
        }
    }
}

@Composable
fun ProfilesScreen(container: AppContainer, onSelected: () -> Unit, onChangeServer: () -> Unit) {
    val vm = viewModel { ProfilesViewModel(container) }
    val state by vm.state.collectAsState()
    when (val s = state) {
        Load.Loading -> Busy()
        is Load.Failed -> ErrorPanel(Txt.error(s.error), listOf(Txt.RETRY to { vm.reload() }, Txt.SERVER_CHANGE to onChangeServer))
        is Load.Ready -> if (s.value.isEmpty()) {
            ErrorPanel(Txt.PROFILES_EMPTY, listOf(Txt.RETRY to { vm.reload() }, Txt.SERVER_CHANGE to onChangeServer))
        } else {
            ProfileChoice(s.value, container.prefs.profileName, vm.selectError, onPick = { vm.select(it, onSelected) }, onChangeServer)
        }
    }
}

@Composable
private fun ProfileChoice(profiles: List<Profile>, lastName: String?, error: String?, onPick: (Profile) -> Unit, onChangeServer: () -> Unit) {
    val first = remember { FocusRequester() }
    val focusIndex = profiles.indexOfFirst { it.name == lastName }.coerceAtLeast(0)
    Box(Modifier.fillMaxSize().padding(48.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(32.dp)) {
            Text(Txt.PROFILES_TITLE, style = MaterialTheme.typography.displaySmall)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                itemsIndexed(profiles, key = { _, p -> p.id }) { i, p ->
                    ProfileTile(p, onClick = { onPick(p) }, modifier = if (i == focusIndex) Modifier.focusRequester(first) else Modifier)
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = PzfColors.Warning) }
            PzfButton(Txt.SERVER_CHANGE, onChangeServer)
        }
    }
    InitialFocus(first)
}

@Composable
private fun ProfileTile(profile: Profile, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.width(150.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            onClick = onClick,
            modifier = Modifier.size(120.dp).testTag("profile-${profile.name}"),
            shape = ClickableSurfaceDefaults.shape(CircleShape),
            colors = ClickableSurfaceDefaults.colors(containerColor = placeholderColor(profile.name), focusedContainerColor = placeholderColor(profile.name)),
            border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(4.dp, PzfColors.Focus), shape = CircleShape)),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(profile.name.take(1).uppercase(), style = MaterialTheme.typography.displaySmall)
            }
        }
        Text(
            profile.name,
            modifier = Modifier.padding(top = 12.dp),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
