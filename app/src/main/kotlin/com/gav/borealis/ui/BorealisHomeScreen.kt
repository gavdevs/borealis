package com.gav.borealis.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewModelScope
import com.gav.borealis.BOREALIS_SYNC_JOB
import com.gav.borealis.BorealisServices
import com.gav.borealis.BuildConfig
import com.gav.borealis.data.BorealisRepository
import com.gav.borealis.data.BorealisSession
import com.gav.borealis.data.PairingStatus
import com.gav.borealis.data.PendingPairingSession
import com.gav.borealis.data.SignedInstallJob
import com.thelightphone.sdk.InitialScreen
import com.thelightphone.sdk.LightScreen
import com.thelightphone.sdk.LightViewModel
import com.thelightphone.sdk.LightWork
import com.thelightphone.sdk.SealedLightActivity
import com.thelightphone.sdk.ui.LightBarButton
import com.thelightphone.sdk.ui.LightBottomBar
import com.thelightphone.sdk.ui.LightFullscreenModal
import com.thelightphone.sdk.ui.LightIcons
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
    val jobs: List<SignedInstallJob> = emptyList(),
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

    init {
        load()
    }

    fun load() {
        requestJob?.cancel()
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            try {
                val local = repository.load()
                _uiState.update {
                    it.copy(
                        session = local.session,
                        pendingPairing = local.pendingPairing,
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
                            statusMessage = "Paired. Choose approved apps in the companion.",
                        )
                    }
                    syncInternal()
                },
                onFailure = { fail(it, "Could not finish pairing.") },
            )
        }
    }

    fun sync() {
        requestJob?.cancel()
        requestJob = viewModelScope.launch(Dispatchers.IO) { syncInternal(showLoading = true) }
    }

    fun install(job: SignedInstallJob) {
        requestJob?.cancel()
        _uiState.update {
            it.copy(loading = true, errorMessage = null, statusMessage = "Preparing ${job.displayName}…")
        }
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            repository.processJob(job).fold(
                onSuccess = { result ->
                    _uiState.update { it.copy(loading = false, statusMessage = result.message) }
                    syncInternal()
                },
                onFailure = { fail(it, "Could not install ${job.displayName}.") },
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
        requestJob = viewModelScope.launch(Dispatchers.IO) {
            repository.forget()
            _uiState.value = BorealisUiState(loading = false)
        }
    }

    fun dismissError() {
        _uiState.update { it.copy(errorMessage = null) }
    }

    private suspend fun syncInternal(showLoading: Boolean = false) {
        if (showLoading) _uiState.update { it.copy(loading = true, errorMessage = null) }
        repository.reconcilePendingInstall()?.let { result ->
            _uiState.update { it.copy(statusMessage = result.message) }
        }
        repository.sync().fold(
            onSuccess = { snapshot ->
                _uiState.update {
                    it.copy(
                        session = snapshot.session,
                        jobs = snapshot.jobs,
                        installAccessGranted = repository.canRequestPackageInstalls,
                        loading = false,
                        errorMessage = null,
                    )
                }
            },
            onFailure = { fail(it, "Could not sync with the companion.") },
        )
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
                            state.loading -> CenterMessage("Working…")
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
        val googleButton = LightBarButton.Text(
            text = "GOOGLE",
            onClick = { navigateTo(::BorealisGoogleScreen) { viewModel.load() } },
        )
        val items = when {
            state.loading -> emptyList()
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
                googleButton,
            )
            else -> listOf(
                googleButton,
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
            text = "Search and approve apps in the Borealis web companion. This phone only installs assigned packages and keeps them current.",
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
    onInstall: (SignedInstallJob) -> Unit,
) {
    LightScrollView(
        modifier = Modifier.fillMaxSize().padding(horizontal = 1f.gridUnitsAsDp()),
    ) {
        LightText(
            text = if (state.jobs.isEmpty()) "ALL QUIET" else "READY FROM COMPANION",
            variant = LightTextVariant.Heading,
            modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
        )
        LightText(
            text = state.statusMessage ?: if (state.jobs.isEmpty()) {
                "No installs or updates are waiting."
            } else {
                "Tap an approved app to download and install it."
            },
            variant = LightTextVariant.Detail,
            modifier = Modifier.padding(top = 0.5f.gridUnitsAsDp(), bottom = 0.75f.gridUnitsAsDp()),
        )
        state.jobs.forEach { job ->
            JobRow(job = job, onClick = { onInstall(job) })
        }
    }
}

@Composable
private fun JobRow(job: SignedInstallJob, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .lightClickable(onClickLabel = "Install ${job.displayName}", onClick = onClick)
            .padding(vertical = 0.75f.gridUnitsAsDp()),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                LightText(job.displayName, LightTextVariant.Copy, maxLines = 2)
                LightText(job.packageName, LightTextVariant.Fine, monospace = true, maxLines = 2)
            }
            LightText("INSTALL", LightTextVariant.Button)
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
