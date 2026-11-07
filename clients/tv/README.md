# Pezzotflix TV

App Android TV di Pezzotflix (ADR 0008, piano `docs/architecture/07-tv-client-plan.md`). Moduli: `:app` (interfaccia),
`:player` (Media3, capacità del dispositivo, ri-pianificazione, sottotitoli forniti a parte), `:api` (client generato dal
contratto più una facciata scritta a mano).

## Requisiti

- JDK 21 in `JAVA_HOME`.
- Android SDK; il percorso va in `clients/tv/local.properties` (`sdk.dir=...`, file non versionato).
- Nient'altro: Gradle si scarica da solo con `gradlew`.

## Build

Dalla cartella `clients/tv`:

| Comando | APK |
|---|---|
| `./gradlew assembleDebug` | `app/build/outputs/apk/debug/app-debug.apk` |
| `./gradlew assembleRelease` | `app/build/outputs/apk/release/app-release.apk` (firmato con la chiave di release, vedi sotto) |
| `./gradlew test lint :api:check` | nessuno: test, lint e controllo del client generato |

- Senza la chiave di release, `assembleRelease` produce `app-release-unsigned.apk`, che non si può installare. La build
  di debug non ha bisogno della chiave.
- Su Windows i percorsi di build possono superare la lunghezza massima: `-PpzfBuildRoot=C:/pzf-b` sposta tutte le
  cartelle di build lì, e l'APK finisce in `C:/pzf-b/app/outputs/apk/<debug|release>/`.
- Per l'emulatore Android (x86): aggiungere `-PpzfExtraAbis=x86,x86_64`. La TV è ARM e non ne ha bisogno.
- Versione attuale: 0.2.0 (versionCode 2).

## Installare sulla TV con ADB in rete

1. Sulla TV: attivare le opzioni sviluppatore (Impostazioni → Sistema → Info → premere sette volte "Build del sistema
   operativo"), poi in Opzioni sviluppatore attivare il debug USB e il debug ADB in rete.
2. Sul PC: **spegnere la VPN FortiClient**, che blocca la rete di casa.
3. `adb connect <ip-della-tv>:5555`. La prima volta la TV chiede di autorizzare il PC: confermare.
4. `adb install -r <percorso dell'APK>` (`-r` aggiorna l'app tenendo i suoi dati).
5. `adb disconnect` alla fine.

### Passare dalla debug alla release (una volta sola)

La debug e la release sono firmate con chiavi diverse: `adb install -r` della release sopra la debug fallisce con
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Serve una disinstallazione:

1. `adb uninstall dev.pezzotflix.tv` (cancella i dati dell'app);
2. `adb install app-release.apk`;
3. all'avvio riscrivere l'indirizzo del server e scegliere di nuovo il profilo.

Da lì in poi ogni nuova release si installa sopra la precedente con `adb install -r`, senza perdere niente.

## La chiave di release

- Si trova **fuori dal repository**: `C:\Users\SimoneMen\.pezzotflix\tv-release.jks` (la chiave) e
  `C:\Users\SimoneMen\.pezzotflix\tv-signing.properties` (dove sta e le sue password). Non va mai copiata nel repo.
- Gradle legge `tv-signing.properties` solo se esiste (in `~/.pezzotflix/`, oppure dove indica
  `-PpzfSigning=<file>`). Il file ha queste righe: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.
- **Fare un backup di entrambi i file** in un posto sicuro (per esempio un disco esterno o un gestore di password).
- **Se la chiave va persa** non si può più aggiornare l'app installata: bisogna disinstallarla (perdendo indirizzo
  del server e profilo, come sopra) e installare una release firmata con una chiave nuova.
- Una chiave nuova si crea con `keytool` del JDK, per esempio:
  `keytool -genkeypair -keystore tv-release.jks -storetype PKCS12 -alias pezzotflix-tv -keyalg RSA -keysize 4096 -validity 36500`.

## Prove sull'emulatore

Sull'emulatore Android l'app accetta due parametri di avvio (anche la release; su un dispositivo vero solo la debug):

```
adb shell am start -n dev.pezzotflix.tv/.MainActivity --ez pzf.softwareDecoders true --es pzf.openItem <itemId>
```

- `pzf.softwareDecoders`: dichiara anche i decoder video software (l'emulatore non ne ha di hardware);
- `pzf.openItem`: apre la scheda di quel titolo sopra la Home.

Dall'emulatore il server del PC si raggiunge a `10.0.2.2:<porta>`.
