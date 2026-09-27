package com.gav.borealis.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewModelScope
import com.gav.borealis.BOREALIS_SYNC_JOB
import com.gav.borealis.BorealisServices
import com.gav.borealis.BuildConfig
import com.gav.borealis.data.BorealisRepository
import com.gav.borealis.data.BorealisSession
import com.gav.borealis.data.LibraryApp
import com.gav.borealis.data.LibraryAppState
import com.gav.borealis.data.LibraryAppStatus
import com.gav.borealis.data.PairingStatus
import com.gav.borealis.data.PendingPairingSession
import com.gav.borealis.install.InstallProgress
import com.gav.borealis.install.InstallStage
import com.thelightphone.sdk.InitialScreen
import com.thelightphone.sdk.LightScreen
import com.thelightphone.sdk.LightViewModel
import com.thelightphone.sdk.LightWork
import com.thelightphone.sdk.SealedLightActivity
import com.thelightphone.sdk.ui.LightBarButton
import com.thelightphone.sdk.ui.LightBottomBar
import com.thelightphone.sdk.ui.LightFullscreenModal
import com.thelightphone.sdk.ui.LightIcons
import com.thelightphone.sdk.ui.LightProgressBar
import com.thelightphone.sdk.ui.LightScrollView
import com.thelightphone.sdk.ui.LightText
import com.thelightphone.sdk.ui.LightTextVariant
import com.thelightphone.sdk.ui.LightTheme
import com.thelightphone.sdk.ui.LightThemeController
import com.thelightphone.sdk.ui.LightThemeTokens
import com.thelightphone.sdk.ui.LightTopBar
import com.thelightphone.sdk.ui.LightTopBarCenter
import com.thelightphone.sdk.ui.gridUnitsAsDp
import com.thelightphone.sdk.ui.lightClickable
import kotlin.time.Duration.Companion.hours
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class BorealisUiState(
    val session: BorealisSession? = null,
    val pendingPairing: PendingPairingSession? = null,
    val pairingStatus: PairingStatus? = null,
    val library: List<LibraryAppState> = emptyList(),
    val installProgress: InstallProgress? = null,
    val installAccessGranted: Boolean = false,
    val loading: Boolean = true,
    val statusMessage: String? = null,
    val errorMessage: String? = null,
)

class BorealisHomeViewModel(
    private val repository: BorealisRepository,
) : LightViewModel<Unit>() {
    private val _uiState = MutableStateFlow(BorealisUiState())
    val uiState: StateFlow<BorealisUiState> = _uiState.asStateFlow()
    private var requestJob: Job? = null
    private var pollJob: Job? = null
    private var installPollJob: Job? = null

    init {
        load()
    }

    fun load() {
        // Returning from Android's confirmation must not cancel an in-flight download/commit.
        if (requestJob?.isActive == true) return
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            try {
                val local = repository.load()
                _uiState.update {
                    it.copy(
                        session = local.session,
                        pendingPairing = local.pendingPairing,
                        library = local.library,
                        installProgress = local.installProgress,
                        installAccessGranted = repository.canRequestPackageInstalls,
                        loading = false,
                        errorMessage = null,
                    )
                }
                if (local.pendingPairing != null) startPolling()
                if (local.session != null) syncInternal()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                fail(error, "Could not load Borealis.")
            }
        }
    }

    fun beginPairing() {
        requestJob?.cancel()
        pollJob?.cancel()
        _uiState.update { it.copy(loading = true, errorMessage = null, statusMessage = null) }
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            repository.beginPairing(BuildConfig.BOREALIS_COMPANION_URL).fold(
                onSuccess = { pending ->
                    _uiState.update { it.copy(pendingPairing = pending, loading = false) }
                    startPolling()
                },
                onFailure = { fail(it, "Could not start pairing.") },
            )
        }
    }

    fun pollNow() {
        startPolling(singleCheck = true)
    }

    fun finishPairing() {
        requestJob?.cancel()
        pollJob?.cancel()
        _uiState.update { it.copy(loading = true, errorMessage = null) }
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            repository.activatePairing().fold(
                onSuccess = { session ->
                    _uiState.update {
                        it.copy(
                            session = session,
                            pendingPairing = null,
                            pairingStatus = null,
                            loading = false,
                            statusMessage = "Paired. Add apps to your library on the website.",
                        )
                    }
                    syncInternal()
                },
                onFailure = { fail(it, "Could not finish pairing.") },
            )
        }
    }

    fun sync() {
        if (requestJob?.isActive == true) return
        requestJob = viewModelScope.launch(Dispatchers.IO) { syncInternal(showLoading = true) }
    }

    fun install(app: LibraryApp) {
        if (requestJob?.isActive == true || _uiState.value.installProgress != null) return
        _uiState.update {
            it.copy(
                loading = true,
                errorMessage = null,
                statusMessage = null,
                installProgress = InstallProgress(app.displayName, InstallStage.Resolving),
            )
        }
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            repository.installLibraryApp(app.packageName) { progress ->
                _uiState.update { it.copy(installProgress = progress) }
            }.fold(
                onSuccess = { result ->
                    _uiState.update { it.copy(loading = false, statusMessage = result.message) }
                    syncInternal()
                },
                onFailure = {
                    recover(it, "Could not install ${app.displayName}.")
                },
            )
        }
    }

    fun openInstallSettings() {
        if (!repository.openInstallAccessSettings()) {
            _uiState.update { it.copy(errorMessage = "Android could not open the install-access setting.") }
        }
    }

    fun forget() {
        requestJob?.cancel()
        pollJob?.cancel()
        installPollJob?.cancel()
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            repository.forget()
            _uiState.value = BorealisUiState(loading = false)
        }
    }

    fun dismissError() {
        _uiState.update { it.copy(errorMessage = null) }
    }

    private suspend fun syncInternal(showLoading: Boolean = false) {
        _uiState.update { it.copy(loading = true, errorMessage = if (showLoading) null else it.errorMessage) }
        try {
            repository.reconcilePendingInstall()?.let { result ->
                _uiState.update { it.copy(statusMessage = result.message) }
            }
            val snapshot = repository.sync().getOrThrow()
            _uiState.update {
                it.copy(
                    session = snapshot.session,
                    library = snapshot.library,
                    installProgress = snapshot.installProgress,
                    installAccessGranted = repository.canRequestPackageInstalls,
                    loading = false,
                    errorMessage = null,
                )
            }
            if (snapshot.pendingInstall != null) startInstallPolling()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            recover(error, "Could not sync with the companion.")
        }
    }

    private suspend fun recover(error: Throwable, fallback: String) {
        val local = try {
            repository.load()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
        if (local != null) {
            _uiState.update { it.copy(library = local.library, installProgress = local.installProgress) }
            if (local.pendingInstall != null) startInstallPolling()
        }
        fail(error, fallback)
    }

    private fun startInstallPolling() {
        if (installPollJob?.isActive == true) return
        installPollJob = viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(2_000L)
                try {
                    repository.reconcilePendingInstall()?.let { result ->
                        _uiState.update { it.copy(statusMessage = result.message) }
                    }
                    val local = repository.load()
                    _uiState.update { it.copy(library = local.library, installProgress = local.installProgress) }
                    if (local.pendingInstall == null) {
                        syncInternal()
                        return@launch
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    fail(error, "Could not check the installation. Refresh to try again.")
                    return@launch
                }
            }
        }
    }

    private fun startPolling(singleCheck: Boolean = false) {
        pollJob?.cancel()
        pollJob = viewModelScope.launch(Dispatchers.IO) {
            do {
                val status = repository.pollPairing().getOrElse {
                    fail(it, "Could not check pairing status.")
                    return@launch
                }
                _uiState.update { it.copy(pairingStatus = status) }
                if (singleCheck || status.isApproved || status.isTerminal) return@launch
                delay(2_000L)
            } while (isActive)
        }
    }

    private fun fail(error: Throwable, fallback: String) {
        _uiState.update {
            it.copy(
                loading = false,
                errorMessage = error.message?.takeIf(String::isNotBlank) ?: fallback,
            )
        }
    }
}

@InitialScreen
class BorealisHomeScreen(sealedActivity: SealedLightActivity) :
    LightScreen<Unit, BorealisHomeViewModel>(sealedActivity) {
    private val services = BorealisServices.from(lightContext)

    override val viewModelClass = BorealisHomeViewModel::class.java
    override fun createViewModel() = BorealisHomeViewModel(services.repository)

    override fun willShow() {
        viewModel.load()
    }

    @Composable
    override fun Content() {
        val colors by LightThemeController.colors.collectAsState()
        val state by viewModel.uiState.collectAsState()
        LaunchedEffect(state.session?.deviceId) {
            if (state.session != null) {
                LightWork.enqueuePeriodic(
                    lightContext = lightContext,
                    jobKey = BOREALIS_SYNC_JOB,
                    repeatInterval = 6.hours,
                )
            }
        }
        LightTheme(colors = colors) {
            Box(
                modifier = Modifier.fillMaxSize().background(LightThemeTokens.colors.background),
            ) {
                Column(modifier = Modifier.fillMaxSize()) {
                    LightTopBar(center = LightTopBarCenter.Text("Borealis"))
                    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        when {
                            state.loading && state.session == null -> CenterMessage("Working…")
                            state.pendingPairing != null -> PairingContent(state)
                            state.session == null -> UnpairedContent()
                            else -> ReadyContent(state, viewModel::install)
                        }
                    }
                    ActionBar(state)
                }
                state.errorMessage?.let { message ->
                    LightFullscreenModal(message = message, onClose = viewModel::dismissError)
                }
            }
        }
    }

    @Composable
    private fun ActionBar(state: BorealisUiState) {
        val signInButton = LightBarButton.Text(
            text = "SIGN IN",
            onClick = { navigateTo(::BorealisGoogleScreen) { viewModel.load() } },
        )
        val items = when {
            state.loading -> emptyList()
            state.installProgress != null -> listOf(
                LightBarButton.LightIcon(
                    icon = LightIcons.REFRESH,
                    onClick = viewModel::sync,
                    contentDescription = "Check installation",
                ),
            )
            state.pendingPairing != null && state.pairingStatus?.isApproved == true -> listOf(
                LightBarButton.Text(text = "CONFIRM", onClick = viewModel::finishPairing),
            )
            state.pendingPairing != null -> listOf(
                LightBarButton.LightIcon(
                    icon = LightIcons.REFRESH,
                    onClick = viewModel::pollNow,
                    contentDescription = "Check pairing",
                ),
            )
            state.session == null -> listOf(
                LightBarButton.Text(text = "PAIR", onClick = viewModel::beginPairing),
            )
            !state.installAccessGranted -> listOf(
                LightBarButton.Text(text = "ALLOW INSTALLS", onClick = viewModel::openInstallSettings),
                signInButton,
            )
            else -> listOf(
                signInButton,
                LightBarButton.LightIcon(
                    icon = LightIcons.REFRESH,
                    onClick = viewModel::sync,
                    contentDescription = "Sync",
                ),
            )
        }
        LightBottomBar(items = items)
    }
}

@Composable
private fun CenterMessage(message: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        LightText(
            text = message,
            variant = LightTextVariant.Copy,
            align = TextAlign.Center,
            modifier = Modifier.padding(1f.gridUnitsAsDp()),
        )
    }
}

@Composable
private fun UnpairedContent() {
    LightScrollView(
        modifier = Modifier.fillMaxSize().padding(horizontal = 1f.gridUnitsAsDp()),
    ) {
        LightText(
            text = "PAIR WITH COMPANION",
            variant = LightTextVariant.Heading,
            modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
        )
        LightText(
            text = "Sign in to the Borealis website, search for apps, and add them to your library. Your library appears here to install and keep up to date.",
            variant = LightTextVariant.Copy,
            modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
        )
        LightText(
            text = BuildConfig.BOREALIS_COMPANION_URL,
            variant = LightTextVariant.Fine,
            monospace = true,
            maxLines = 5,
            modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
        )
    }
}

@Composable
private fun PairingContent(state: BorealisUiState) {
    val pending = checkNotNull(state.pendingPairing)
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(horizontal = 1f.gridUnitsAsDp()),
        ) {
            LightText(
                text = pending.pairing.userCode,
                variant = LightTextVariant.Heading,
                monospace = true,
                align = TextAlign.Center,
            )
            LightText(
                text = pending.pairing.verificationUrl,
                variant = LightTextVariant.Fine,
                maxLines = 6,
                align = TextAlign.Center,
                modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
            )
            LightText(
                text = when {
                    state.pairingStatus?.isApproved == true -> "APPROVED — CONFIRM BELOW"
                    state.pairingStatus?.isTerminal == true -> "PAIRING EXPIRED"
                    else -> "WAITING FOR APPROVAL"
                },
                variant = LightTextVariant.Copy,
                align = TextAlign.Center,
                modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
            )
        }
    }
}

@Composable
private fun ReadyContent(
    state: BorealisUiState,
    onInstall: (LibraryApp) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 1f.gridUnitsAsDp()),
    ) {
        LightText(
            text = "YOUR LIBRARY",
            variant = LightTextVariant.Heading,
            modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
        )
        state.installProgress?.let { InstallProgressContent(it) }
        if (state.loading && state.installProgress == null) {
            LightText("Syncing library and checking for updates…", LightTextVariant.Detail)
            BusyBar()
        }
        LightScrollView(modifier = Modifier.weight(1f).fillMaxWidth()) {
            LightText(
                text = state.statusMessage ?: if (state.library.isEmpty()) {
                    "Add apps to your library on the Borealis website, then refresh here."
                } else {
                    "Apps added on the website stay here after installation."
                },
                variant = LightTextVariant.Detail,
                modifier = Modifier.padding(top = 0.5f.gridUnitsAsDp(), bottom = 0.75f.gridUnitsAsDp()),
            )
            state.library.forEach { app ->
                LibraryRow(
                    state = app,
                    enabled = !state.loading && state.installProgress == null && state.installAccessGranted,
                    onClick = { onInstall(app.app) },
                )
            }
        }
    }
}

@Composable
private fun LibraryRow(state: LibraryAppState, enabled: Boolean, onClick: () -> Unit) {
    val app = state.app
    val action = when (state.status) {
        LibraryAppStatus.NotInstalled -> "INSTALL"
        LibraryAppStatus.UpdateAvailable -> "UPDATE"
        else -> null
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (enabled && action != null) {
                Modifier.lightClickable(onClickLabel = "$action ${app.displayName}", onClick = onClick)
            } else Modifier)
            .padding(vertical = 0.75f.gridUnitsAsDp()),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                LightText(app.displayName, LightTextVariant.Copy, maxLines = 2)
                LightText(
                    text = when (state.status) {
                        LibraryAppStatus.NotInstalled -> "Not installed"
                        LibraryAppStatus.UpToDate -> "Up to date"
                        LibraryAppStatus.UpdateAvailable -> "Update available"
                        LibraryAppStatus.UpdateStatusUnknown -> "Installed · update check unavailable"
                    },
                    variant = LightTextVariant.Fine,
                    maxLines = 2,
                )
            }
            if (action != null) LightText(action, LightTextVariant.Button)
        }
        Box(
            modifier = Modifier
                .padding(top = 0.75f.gridUnitsAsDp())
                .fillMaxWidth()
                .height(1f.gridUnitsAsDp() / 16),
        ) {
            Box(modifier = Modifier.fillMaxSize().background(LightThemeTokens.colors.contentSecondary))
        }
    }
}

@Composable
private fun InstallProgressContent(progress: InstallProgress) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 0.5f.gridUnitsAsDp())) {
        LightText(progress.displayName, LightTextVariant.Copy, maxLines = 2)
        LightText(
            text = when (progress.stage) {
                InstallStage.Resolving -> "Getting app from Google Play…"
                InstallStage.Downloading -> "Downloading…"
                InstallStage.Verifying -> "Verifying download…"
                InstallStage.Installing -> "Installing with Android…"
                InstallStage.AwaitingConfirmation -> "Confirm installation in Android."
                InstallStage.ReportingResult -> "Saving installation status…"
            },
            variant = LightTextVariant.Detail,
        )
        progress.download?.let { download ->
            val fraction = downloadFraction(download.downloadedBytes, download.totalBytes)
            Box(modifier = Modifier.fillMaxWidth().padding(vertical = 0.25f.gridUnitsAsDp()).semantics {
                progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
            }) {
                LightProgressBar(LightThemeTokens.colors, fraction)
            }
            LightText(
                text = "${(fraction * 100).toInt()}% · ${downloadBytes(download.downloadedBytes)} / ${downloadBytes(download.totalBytes)}",
                variant = LightTextVariant.Fine,
            )
            if (download.totalFiles > 1) {
                LightText("File ${download.currentFile} of ${download.totalFiles}", LightTextVariant.Fine)
            }
        }
        if (progress.download == null && progress.stage != InstallStage.AwaitingConfirmation) BusyBar()
    }
}

/** An unknown duration is visibly busy, never represented as invented completion. */
@Composable
private fun BusyBar() {
    val transition = rememberInfiniteTransition(label = "Borealis loading")
    val position by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1_200, easing = LinearEasing), RepeatMode.Reverse),
        label = "Loading position",
    )
    BoxWithConstraints(
        modifier = Modifier.fillMaxWidth().padding(vertical = 0.25f.gridUnitsAsDp())
            .height(0.5f.gridUnitsAsDp()).semantics {
                progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(Modifier.fillMaxWidth().height(0.1f.gridUnitsAsDp()).background(LightThemeTokens.colors.contentSecondary))
        Box(
            Modifier.offset(x = maxWidth * (position * 0.75f)).width(maxWidth * 0.25f)
                .height(0.5f.gridUnitsAsDp()).background(LightThemeTokens.colors.content),
        )
    }
}

internal fun downloadFraction(downloaded: Long, total: Long): Float =
    if (total <= 0L) 0f else (downloaded.toDouble() / total.toDouble()).coerceIn(0.0, 1.0).toFloat()

internal fun downloadBytes(bytes: Long): String {
    val safe = bytes.coerceAtLeast(0L)
    if (safe < 1_048_576L) return "${safe / 1024} KB"
    val tenths = (safe / 1_048_576L) * 10L + (safe % 1_048_576L) * 10L / 1_048_576L
    return "${tenths / 10}.${tenths % 10} MB"
}
