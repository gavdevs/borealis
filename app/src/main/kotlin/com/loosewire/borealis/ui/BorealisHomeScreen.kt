package com.loosewire.borealis.ui

import android.os.Build
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
import androidx.compose.foundation.text.input.rememberTextFieldState
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
import com.loosewire.borealis.BOREALIS_SYNC_JOB
import com.loosewire.borealis.BorealisServices
import com.loosewire.borealis.BuildConfig
import com.loosewire.borealis.data.BorealisRepository
import com.loosewire.borealis.data.BorealisSession
import com.loosewire.borealis.data.LibraryApp
import com.loosewire.borealis.data.LibraryAppState
import com.loosewire.borealis.data.LibraryAppStatus
import com.loosewire.borealis.data.PairingStatus
import com.loosewire.borealis.data.PendingPairingSession
import com.loosewire.borealis.data.ProblemReportContext
import com.loosewire.borealis.data.formatProblemReportDiagnostics
import com.loosewire.borealis.data.problemReportDescription
import com.loosewire.borealis.data.problemReportFailureMessage
import com.loosewire.borealis.data.problemReportTitle
import com.loosewire.borealis.data.problemReportValidationError
import com.loosewire.borealis.install.InstallProgress
import com.loosewire.borealis.install.InstallStage
import com.loosewire.borealis.install.UninstallProgress
import com.loosewire.borealis.install.UninstallStage
import com.loosewire.borealis.install.blocksInstall
import com.thelightphone.sdk.InitialScreen
import com.thelightphone.sdk.LightScreen
import com.thelightphone.sdk.LightViewModel
import com.thelightphone.sdk.LightWork
import com.thelightphone.sdk.SealedLightActivity
import com.thelightphone.sdk.SimpleLightScreen
import com.thelightphone.sdk.rememberKeyboardOptions
import com.thelightphone.sdk.ui.LightBarButton
import com.thelightphone.sdk.ui.LightBottomBar
import com.thelightphone.sdk.ui.LightFullscreenModal
import com.thelightphone.sdk.ui.LightIcons
import com.thelightphone.sdk.ui.LightProgressBar
import com.thelightphone.sdk.ui.LightScrollView
import com.thelightphone.sdk.ui.LightText
import com.thelightphone.sdk.ui.LightTextField
import com.thelightphone.sdk.ui.LightTextInputEditor
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
    val uninstallProgress: UninstallProgress? = null,
    val pendingUninstallConfirm: LibraryApp? = null,
    val installAccessGranted: Boolean = false,
    val googleAccountStatus: GoogleAccountStatus = GoogleAccountStatus.Unavailable,
    val loading: Boolean = true,
    val statusMessage: String? = null,
    val errorMessage: String? = null,
)

class BorealisHomeViewModel(
    private val repository: BorealisRepository,
    private val isGoogleConnected: suspend () -> Boolean,
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
        // Returning from Android's confirmation / settings must not cancel an
        // in-flight download/commit, but it SHOULD re-read the stored grant.
        if (requestJob?.isActive == true) {
            refreshInstallAccess()
            return
        }
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            try {
                val local = repository.load()
                val googleAccountStatus = readGoogleAccountStatus(isGoogleConnected)
                _uiState.update {
                    it.copy(
                        session = local.session,
                        pendingPairing = local.pendingPairing,
                        library = local.library,
                        installProgress = local.installProgress,
                        uninstallProgress = local.uninstallProgress,
                        installAccessGranted = repository.canRequestPackageInstalls,
                        googleAccountStatus = googleAccountStatus,
                        loading = false,
                        errorMessage = null,
                    )
                }
                if (local.pendingPairing != null) startPolling()
                if (local.pendingInstall != null || local.pendingUninstall != null) startInstallPolling()
                if (local.session != null) syncInternal()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                fail(error, "Could not load Borealis.")
            }
        }
    }

    fun refreshInstallAccess() {
        _uiState.update { it.copy(installAccessGranted = repository.canRequestPackageInstalls) }
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
        if (requestJob?.isActive == true) return
        // Only an active download or commit blocks a tap. A pending Android confirmation
        // is replaced immediately: Android never re-opens it, so waiting cannot help.
        if (_uiState.value.installProgress?.blocksInstall == true) return
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

    fun confirmUninstall(app: LibraryApp) {
        _uiState.update { it.copy(pendingUninstallConfirm = app) }
    }

    fun cancelUninstall() {
        _uiState.update { it.copy(pendingUninstallConfirm = null) }
    }

    fun startUninstall(app: LibraryApp) {
        if (requestJob?.isActive == true || _uiState.value.uninstallProgress != null) return
        _uiState.update {
            it.copy(
                loading = true,
                errorMessage = null,
                statusMessage = null,
                pendingUninstallConfirm = null,
                uninstallProgress = UninstallProgress(app.displayName, UninstallStage.Starting),
            )
        }
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            repository.uninstallLibraryApp(app.packageName).fold(
                onSuccess = { result ->
                    _uiState.update { it.copy(loading = false, statusMessage = result.message) }
                    syncInternal()
                },
                onFailure = {
                    recover(it, "Could not uninstall ${app.displayName}.")
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
            if (showLoading) {
                val googleAccountStatus = readGoogleAccountStatus(isGoogleConnected)
                _uiState.update { it.copy(googleAccountStatus = googleAccountStatus) }
            }
            repository.reconcilePendingInstall()?.let { result ->
                _uiState.update { it.copy(statusMessage = result.message) }
            }
            val snapshot = repository.sync().getOrThrow()
            _uiState.update {
                it.copy(
                    session = snapshot.session,
                    library = snapshot.library,
                    // A retry clears the stored session before it downloads, so the
                    // snapshot must not blank progress the request job is reporting.
                    installProgress = if (requestJob?.isActive == true) {
                        it.installProgress ?: snapshot.installProgress
                    } else {
                        snapshot.installProgress
                    },
                    uninstallProgress = snapshot.uninstallProgress,
                    installAccessGranted = repository.canRequestPackageInstalls,
                    loading = false,
                    errorMessage = null,
                )
            }
            if (snapshot.pendingInstall != null || snapshot.pendingUninstall != null) startInstallPolling()
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
            _uiState.update { it.copy(library = local.library, installProgress = local.installProgress, uninstallProgress = local.uninstallProgress) }
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
                    repository.reconcilePendingUninstall()?.let { result ->
                        _uiState.update { it.copy(statusMessage = result.message) }
                    }
                    val local = repository.load()
                    _uiState.update {
                        it.copy(
                            library = local.library,
                            installProgress = local.installProgress,
                            uninstallProgress = local.uninstallProgress,
                        )
                    }
                    if (local.pendingInstall == null && local.pendingUninstall == null) {
                        // A retry in flight reports its own result; sync afterwards.
                        if (requestJob?.isActive != true) syncInternal()
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
    override fun createViewModel() = BorealisHomeViewModel(services.repository, services::isGoogleConnected)

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
                            !state.installAccessGranted -> InstallAccessContent(viewModel::openInstallSettings)
                            else -> ReadyContent(state, viewModel::install, viewModel::confirmUninstall)
                        }
                    }
                    ActionBar(state)
                }
                state.errorMessage?.let { message ->
                    LightFullscreenModal(message = message, onClose = viewModel::dismissError)
                }
                state.pendingUninstallConfirm?.let { app ->
                    UninstallConfirmOverlay(
                        app = app,
                        onCancel = viewModel::cancelUninstall,
                        onConfirm = { viewModel.startUninstall(app) },
                    )
                }
            }
        }
    }

    @Composable
    private fun ActionBar(state: BorealisUiState) {
        val googleAccountButton = LightBarButton.Text(
            text = state.googleAccountStatus.buttonLabel,
            onClick = { navigateTo(::BorealisGoogleScreen) { viewModel.load() } },
        )
        val reportButton = LightBarButton.Text(
            text = "REPORT",
            onClick = { navigateTo(::BorealisReportScreen) },
        )
        val items = when {
            state.loading -> emptyList()
            state.installProgress?.blocksInstall == true || state.uninstallProgress != null -> listOf(
                reportButton,
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
            !state.installAccessGranted -> listOf(googleAccountButton, reportButton)
            else -> listOf(
                googleAccountButton,
                reportButton,
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

/**
 * Shown on open (and after returning from settings) whenever Android has not yet
 * granted Borealis "install unknown apps" — which also gates uninstalls — so the
 * user is told to enable it instead of seeing a silently disabled library.
 */
@Composable
private fun InstallAccessContent(onGrant: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 1f.gridUnitsAsDp()),
    ) {
        LightText(
            text = "ALLOW APP INSTALLS",
            variant = LightTextVariant.Heading,
            modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
        )
        LightText(
            text = "Borealis needs Android's \"install unknown apps\" permission to install, update, and uninstall library apps. Enable it for Borealis in system settings, then refresh.",
            variant = LightTextVariant.Copy,
            modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
        )
        LightText(
            text = "OPEN SETTINGS",
            variant = LightTextVariant.Button,
            modifier = Modifier
                .padding(top = 1f.gridUnitsAsDp())
                .lightClickable(onClickLabel = "Open install access settings", onClick = onGrant),
        )
    }
}

@Composable
private fun ReadyContent(
    state: BorealisUiState,
    onInstall: (LibraryApp) -> Unit,
    onUninstall: (LibraryApp) -> Unit,
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
        state.uninstallProgress?.let { UninstallProgressContent(it) }
        if (state.loading && state.installProgress?.blocksInstall != true && state.uninstallProgress == null) {
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
                    enabled = !state.loading && state.installProgress?.blocksInstall != true &&
                        state.uninstallProgress == null && state.installAccessGranted,
                    onClick = { onInstall(app.app) },
                    onUninstall = { onUninstall(app.app) },
                )
            }
        }
    }
}

@Composable
private fun LibraryRow(
    state: LibraryAppState,
    enabled: Boolean,
    onClick: () -> Unit,
    onUninstall: () -> Unit,
) {
    val app = state.app
    val action = when (state.status) {
        LibraryAppStatus.NotInstalled -> "INSTALL"
        LibraryAppStatus.UpdateAvailable -> "UPDATE"
        else -> null
    }
    val isInstalled = state.installedVersionCode != null
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
        if (isInstalled) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {}
                LightText(
                    text = "UNINSTALL",
                    variant = LightTextVariant.Fine,
                    modifier = Modifier
                        .then(if (enabled) {
                            Modifier.lightClickable(onClickLabel = "Uninstall ${app.displayName}", onClick = onUninstall)
                        } else Modifier)
                        .padding(top = 0.25f.gridUnitsAsDp()),
                )
            }
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
                InstallStage.AwaitingConfirmation -> "Confirm the installation in Android."
                InstallStage.Interrupted -> "Android never confirmed this install. Tap it to start a new confirmation."
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
        if (progress.download == null && progress.stage != InstallStage.AwaitingConfirmation &&
            progress.stage != InstallStage.Interrupted
        ) {
            BusyBar()
        }
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

/** Uninstall confirmations stay separate from [LightFullscreenModal], which has no action button. */
@Composable
private fun UninstallConfirmOverlay(
    app: LibraryApp,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(LightThemeTokens.colors.background),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 1f.gridUnitsAsDp()),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                LightText(
                    text = "UNINSTALL ${app.displayName.uppercase()}?",
                    variant = LightTextVariant.Heading,
                    align = TextAlign.Center,
                )
                LightText(
                    text = "This removes the app from your phone. It stays in your Borealis library and you can reinstall it later.",
                    variant = LightTextVariant.Copy,
                    align = TextAlign.Center,
                    modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
                )
            }
        }
        LightBottomBar(
            items = listOf(
                LightBarButton.Text(text = "CANCEL", onClick = onCancel),
                LightBarButton.Text(text = "UNINSTALL", onClick = onConfirm),
            ),
        )
    }
}

@Composable
private fun UninstallProgressContent(progress: UninstallProgress) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 0.5f.gridUnitsAsDp())) {
        LightText(progress.displayName, LightTextVariant.Copy, maxLines = 2)
        LightText(
            text = when (progress.stage) {
                UninstallStage.Starting -> "Asking Android to uninstall…"
                UninstallStage.AwaitingConfirmation -> "Confirm the uninstall in Android."
                UninstallStage.ReportingResult -> "Updating library…"
            },
            variant = LightTextVariant.Detail,
        )
        if (progress.stage == UninstallStage.Starting) BusyBar()
    }
}

data class ReportFormState(
    val title: String = "",
    val description: String = "",
    val includeDiagnostics: Boolean = true,
    val sending: Boolean = false,
    val sent: Boolean = false,
    val errorMessage: String? = null,
    val context: ProblemReportContext? = null,
    val diagnosticsText: String? = null,
)

/**
 * The rendered preview and the submitted `diagnostics` field are the same
 * snapshot string, so the screen cannot show one thing and send another.
 */
internal fun reportDiagnosticsPreview(state: ReportFormState): String? =
    if (state.includeDiagnostics) state.diagnosticsText else null

class BorealisReportViewModel(
    private val repository: BorealisRepository,
    private val isGoogleConnected: suspend () -> Boolean,
    private val appVersion: String,
    private val androidSdk: Int,
    private val deviceModel: String,
) : LightViewModel<Unit>() {
    private val _uiState = MutableStateFlow(ReportFormState())
    val uiState: StateFlow<ReportFormState> = _uiState.asStateFlow()
    private var contextJob: Job? = null

    /** Read on show; the report describes this phone at the time it is filed. */
    fun loadContext() {
        if (contextJob?.isActive == true) return
        contextJob = viewModelScope.launch(Dispatchers.IO) {
            val snapshot = try {
                repository.load()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
            val googlePlayConnected = try {
                isGoogleConnected()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
            val reportContext = ProblemReportContext(
                appVersion = appVersion,
                androidSdk = androidSdk,
                deviceModel = deviceModel,
                paired = snapshot?.session != null,
                libraryApps = snapshot?.library?.size ?: 0,
                installedApps = snapshot?.library?.count { app -> app.installedVersionCode != null } ?: 0,
                googlePlayConnected = googlePlayConnected,
                installInProgress = snapshot?.pendingInstall != null,
                uninstallInProgress = snapshot?.pendingUninstall != null,
            )
            _uiState.update {
                it.copy(
                    context = reportContext,
                    diagnosticsText = formatProblemReportDiagnostics(reportContext),
                )
            }
        }
    }

    fun setTitle(value: String) {
        _uiState.update { it.copy(title = problemReportTitle(value), errorMessage = null) }
    }

    fun setDescription(value: String) {
        _uiState.update { it.copy(description = problemReportDescription(value), errorMessage = null) }
    }

    fun setIncludeDiagnostics(include: Boolean) {
        _uiState.update { it.copy(includeDiagnostics = include) }
    }

    fun send() {
        val state = _uiState.value
        if (state.sending) return
        val context = state.context
        if (context == null) {
            _uiState.update { it.copy(errorMessage = "Still reading this phone's state. Try again in a moment.") }
            return
        }
        if (!context.paired) {
            _uiState.update { it.copy(errorMessage = "Pair this phone before reporting so the companion can authenticate it.") }
            return
        }
        val validation = problemReportValidationError(state.title, state.description)
        if (validation != null) {
            _uiState.update { it.copy(errorMessage = validation) }
            return
        }
        val diagnostics = reportDiagnosticsPreview(state)
        _uiState.update { it.copy(sending = true, errorMessage = null) }
        viewModelScope.launch(Dispatchers.IO) {
            repository.submitProblemReport(state.title, state.description, diagnostics).fold(
                onSuccess = {
                    _uiState.update { it.copy(sending = false, sent = true) }
                },
                onFailure = { error ->
                    _uiState.update {
                        it.copy(sending = false, errorMessage = problemReportFailureMessage(error))
                    }
                },
            )
        }
    }
}

/**
 * Discoverable from the home bottom bar. States plainly that filing creates a
 * public issue, shows the exact diagnostics text, and offers retry on failure.
 */
class BorealisReportScreen(sealedActivity: SealedLightActivity) :
    LightScreen<Unit, BorealisReportViewModel>(sealedActivity) {
    private val services = BorealisServices.from(lightContext)

    override val viewModelClass = BorealisReportViewModel::class.java

    override fun createViewModel() = BorealisReportViewModel(
        repository = services.repository,
        isGoogleConnected = services::isGoogleConnected,
        appVersion = BuildConfig.VERSION_NAME,
        androidSdk = Build.VERSION.SDK_INT,
        deviceModel = Build.MODEL.orEmpty(),
    )

    override fun willShow() {
        viewModel.loadContext()
    }

    @Composable
    override fun Content() {
        val colors by LightThemeController.colors.collectAsState()
        val state by viewModel.uiState.collectAsState()
        LightTheme(colors = colors) {
            Column(Modifier.fillMaxSize().background(LightThemeTokens.colors.background)) {
                LightTopBar(center = LightTopBarCenter.Text("Report a problem"))
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    if (state.sent) {
                        ReportSentContent()
                    } else {
                        ReportFormContent(
                            state = state,
                            diagnostics = reportDiagnosticsPreview(state),
                            onEditTitle = { openEditor("Title", state.title, singleLine = true, viewModel::setTitle) },
                            onEditDescription = {
                                openEditor("Details", state.description, singleLine = false, viewModel::setDescription)
                            },
                            onToggleDiagnostics = viewModel::setIncludeDiagnostics,
                            onRetry = viewModel::send,
                        )
                    }
                }
                LightBottomBar(
                    items = when {
                        state.sent -> listOf(LightBarButton.Text("DONE", onClick = { goBack(Unit) }))
                        state.sending -> emptyList()
                        else -> listOf(
                            LightBarButton.Text("BACK", onClick = { goBack(Unit) }),
                            LightBarButton.Text("SEND", enabled = state.context != null, onClick = viewModel::send),
                        )
                    },
                )
            }
        }
    }

    private fun openEditor(
        label: String,
        current: String,
        singleLine: Boolean,
        onResult: (String) -> Unit,
    ) {
        navigateTo(
            screenFactory = { activity -> ReportTextEditorScreen(activity, label, current, singleLine) },
            resultCallback = { value -> if (value != null) onResult(value) },
        )
    }
}

@Composable
private fun ReportFormContent(
    state: ReportFormState,
    diagnostics: String?,
    onEditTitle: () -> Unit,
    onEditDescription: () -> Unit,
    onToggleDiagnostics: (Boolean) -> Unit,
    onRetry: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 1f.gridUnitsAsDp())) {
        LightScrollView(modifier = Modifier.weight(1f).fillMaxWidth()) {
            LightText(
                text = "REPORT A PROBLEM",
                variant = LightTextVariant.Heading,
                modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
            )
            LightText(
                text = "Sending creates a public issue on the Borealis GitHub repository. Leave out passwords, account details, and anything private.",
                variant = LightTextVariant.Copy,
                modifier = Modifier.padding(top = 0.5f.gridUnitsAsDp()),
            )
            LightTextField(
                label = "Title:",
                value = state.title,
                placeholder = "What went wrong?",
                onClick = onEditTitle,
                modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
            )
            LightTextField(
                label = "Details:",
                value = state.description,
                placeholder = "What did you see?",
                onClick = onEditDescription,
                modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
            )
            LightText(
                text = if (state.includeDiagnostics) "DIAGNOSTICS: INCLUDED" else "DIAGNOSTICS: NOT INCLUDED",
                variant = LightTextVariant.Button,
                modifier = Modifier
                    .padding(top = 1.25f.gridUnitsAsDp())
                    .lightClickable(
                        onClickLabel = if (state.includeDiagnostics) {
                            "Exclude diagnostics"
                        } else {
                            "Include diagnostics"
                        },
                        onClick = { onToggleDiagnostics(!state.includeDiagnostics) },
                    ),
            )
            LightText(
                text = "Version, device, pairing state, and recent app stages. Never your credential, email, or logcat.",
                variant = LightTextVariant.Detail,
                modifier = Modifier.padding(top = 0.25f.gridUnitsAsDp()),
            )
            if (diagnostics != null) {
                LightText(
                    text = diagnostics,
                    variant = LightTextVariant.Fine,
                    monospace = true,
                    modifier = Modifier.padding(top = 0.5f.gridUnitsAsDp()),
                )
            }
            state.errorMessage?.let { message ->
                LightText(
                    text = message,
                    variant = LightTextVariant.Copy,
                    modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
                )
                LightText(
                    text = "RETRY",
                    variant = LightTextVariant.Button,
                    modifier = Modifier
                        .padding(top = 0.5f.gridUnitsAsDp())
                        .lightClickable(onClickLabel = "Retry sending the report", onClick = onRetry),
                )
            }
            if (state.sending) {
                LightText(
                    text = "Sending report…",
                    variant = LightTextVariant.Detail,
                    modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
                )
                BusyBar()
            }
        }
    }
}

@Composable
private fun ReportSentContent() {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 1f.gridUnitsAsDp()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        LightText(
            text = "REPORT SENT",
            variant = LightTextVariant.Heading,
            modifier = Modifier.padding(top = 1f.gridUnitsAsDp()),
        )
        LightText(
            text = "Thank you. The issue is public on the Borealis GitHub repository.",
            variant = LightTextVariant.Copy,
            align = TextAlign.Center,
            modifier = Modifier.padding(top = 0.5f.gridUnitsAsDp()),
        )
    }
}

/** Null result means the user backed out, so the previous value stays. */
private class ReportTextEditorScreen(
    sealedActivity: SealedLightActivity,
    private val label: String,
    private val initialValue: String,
    private val singleLine: Boolean,
) : SimpleLightScreen<String?>(sealedActivity) {
    @Composable
    override fun Content() {
        val colors by LightThemeController.colors.collectAsState()
        val textState = rememberTextFieldState(initialValue)
        val keyboardOptions = rememberKeyboardOptions()
        LightTheme(colors = colors) {
            LightTextInputEditor(
                title = label,
                state = textState,
                keyboardOptionsFlow = keyboardOptions,
                singleLine = singleLine,
                onSubmit = { value -> goBack(value.toString()) },
                onBack = { goBack(null) },
                modifier = Modifier.background(LightThemeTokens.colors.background),
            )
        }
    }
}
