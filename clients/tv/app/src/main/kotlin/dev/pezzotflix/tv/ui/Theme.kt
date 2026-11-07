package dev.pezzotflix.tv.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Typography
import androidx.tv.material3.darkColorScheme

/** Plain and readable from the sofa: dark background, large type, a white focus that cannot be missed. */
object PzfColors {
    val Background = Color(0xFF0E0E10)
    val Surface = Color(0xFF1C1C21)
    val Text = Color(0xFFF2F2F2)
    val Muted = Color(0xFFB0B0B8)
    val Accent = Color(0xFFE50914)
    val Focus = Color.White
    val Warning = Color(0xFFFFC857)
}

private val Scheme = darkColorScheme(
    primary = PzfColors.Text,
    onPrimary = Color.Black,
    secondary = PzfColors.Accent,
    background = PzfColors.Background,
    onBackground = PzfColors.Text,
    surface = PzfColors.Surface,
    onSurface = PzfColors.Text,
    surfaceVariant = Color(0xFF2A2A31),
    onSurfaceVariant = PzfColors.Muted,
    border = PzfColors.Focus,
)

private val Type = Typography(
    displaySmall = TextStyle(fontSize = 36.sp, fontWeight = FontWeight.Bold),
    headlineMedium = TextStyle(fontSize = 28.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 18.sp),
    bodyMedium = TextStyle(fontSize = 16.sp),
    labelLarge = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun PzfTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, typography = Type) {
        // tv-material's Text takes LocalContentColor, black outside a Surface: light text on the dark background.
        CompositionLocalProvider(LocalContentColor provides PzfColors.Text, content = content)
    }
}
