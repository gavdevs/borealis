package com.gav.borealis.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewModelScope
import com.gav.borealis.BorealisServices
import com.thelightphone.sdk.LightScreen
import com.thelightphone.sdk.LightViewModel
import com.thelightphone.sdk.SealedLightActivity
import com.thelightphone.sdk.auth.GooglePlaySignIn
import com.thelightphone.sdk.ui.LightBarButton
import com.thelightphone.sdk.ui.LightBottomBar
import com.thelightphone.sdk.ui.LightScrollView
import com.thelightphone.sdk.ui.LightText
import com.thelightphone.sdk.ui.LightTextVariant
import com.thelightphone.sdk.ui.LightTheme
import com.thelightphone.sdk.ui.LightThemeController
import com.thelightphone.sdk.ui.LightThemeTokens
import com.thelightphone.sdk.ui.LightTopBar
import com.thelightphone.sdk.ui.LightTopBarCenter
import com.thelightphone.sdk.ui.gridUnitsAsDp
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class GoogleConnectionState(
    val connected: Boolean = false,
    val loading: Boolean = true,
    val signingIn: Boolean = false,
    val message: String? = null,
)

class BorealisGoogleViewModel(private val services: BorealisServices) : LightViewModel<Unit>() {
    private val state = MutableStateFlow(GoogleConnectionState())
    val uiState = state.asStateFlow()
    private var operation: Job? = null
    private val generation = AtomicLong()

    init { refresh() }

    fun refresh() {
        val previous = operation
        val attempt = generation.incrementAndGet()
        previous?.cancel()
        state.update { it.copy(signingIn = false, loading = true) }
        operation = viewModelScope.launch(Dispatchers.IO) {
            try {
                previous?.join()
                val connected = services.isGoogleConnected()
                if (generation.get() == attempt) {
                    state.update { it.copy(connected = connected, loading = false, message = null) }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                if (generation.get() == attempt) {
                    fail("Could not read the protected Google connection. Disconnect it and sign in again.")
                }
            }
        }
    }

    fun begin() {
        if (state.value.loading) return
        state.update { it.copy(signingIn = true, message = null) }
    }

    fun cancel() {
        refresh()
    }

    fun fail(message: String) {
        state.update { it.copy(signingIn = false, loading = false, message = message) }
    }

    fun finish(email: String, oauthToken: String) {
        if (!state.value.signingIn) return
        val attempt = generation.incrementAndGet()
        state.update { it.copy(signingIn = false, loading = true, message = "Connecting to Google Play…") }
        operation = viewModelScope.launch(Dispatchers.IO) {
            try {
                services.connectGoogle(email, oauthToken)
                if (generation.get() == attempt) {
                    state.value = GoogleConnectionState(connected = true, loading = false, message = "Connected on this phone.")
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                if (generation.get() == attempt) {
                    fail("Google Play could not complete the connection. You can retry sign-in; your password was not stored.")
                }
            }
        }
    }

    fun disconnect() {
        val previous = operation
        val attempt = generation.incrementAndGet()
        previous?.cancel()
        state.update { it.copy(signingIn = false, loading = true, message = null) }
        operation = viewModelScope.launch(Dispatchers.IO) {
            try {
                previous?.join()
                services.disconnectGoogle()
                if (generation.get() == attempt) {
                    state.value = GoogleConnectionState(loading = false, message = "Google connection removed from this phone.")
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                if (generation.get() == attempt) fail("Could not remove the Google connection. Try again.")
            }
        }
    }
}

class BorealisGoogleScreen(sealedActivity: SealedLightActivity) :
    LightScreen<Unit, BorealisGoogleViewModel>(sealedActivity) {
    override val viewModelClass = BorealisGoogleViewModel::class.java
    override fun createViewModel() = BorealisGoogleViewModel(BorealisServices.from(lightContext))

    override fun onAppPause() { viewModel.cancel() }
    override fun willHide() { viewModel.cancel() }
    override fun willShow() { viewModel.refresh() }

    @Composable
    override fun Content() {
        val colors by LightThemeController.colors.collectAsState()
        val state by viewModel.uiState.collectAsState()
        LightTheme(colors = colors) {
            Column(Modifier.fillMaxSize().background(LightThemeTokens.colors.background)) {
                LightTopBar(center = LightTopBarCenter.Text("Google Play"))
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    if (state.signingIn) {
                        lightContext.GooglePlaySignIn(
                            modifier = Modifier.fillMaxSize(),
                            onCredential = { viewModel.finish(it.email, it.oauthToken) },
                            onError = viewModel::fail,
                        )
                    } else {
                        LightScrollView(Modifier.fillMaxSize().padding(1f.gridUnitsAsDp())) {
                            LightText(
                                if (state.connected) "CONNECTED" else "CONNECT GOOGLE PLAY",
                                LightTextVariant.Heading,
                            )
                            LightText(
                                state.message ?: if (state.loading) "Checking connection…" else
                                    "Experimental sign-in runs on this phone. Google credentials stay here, not in the companion server.",
                                LightTextVariant.Copy,
                                modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
                            )
                            if (!state.connected && !state.loading) {
                                LightText(
                                    "This first prototype checks Google sign-in on the LP3. Companion keyboard assistance is not enabled yet. Google may reject this browser or require extra verification.",
                                    LightTextVariant.Copy,
                                    modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
                                )
                            }
                            if (state.connected) {
                                LightText(
                                    "Disconnect removes Borealis's saved connection. It does not revoke access in your Google account settings.",
                                    LightTextVariant.Copy,
                                    modifier = Modifier.padding(top = 0.75f.gridUnitsAsDp()),
                                )
                            }
                        }
                    }
                }
                LightBottomBar(items = when {
                    state.signingIn -> listOf(LightBarButton.Text("CANCEL", onClick = viewModel::cancel))
                    state.loading -> emptyList()
                    state.connected -> listOf(
                        LightBarButton.Text("BACK", onClick = { goBack(Unit) }),
                        LightBarButton.Text("DISCONNECT", onClick = viewModel::disconnect),
                    )
                    else -> listOf(
                        LightBarButton.Text("BACK", onClick = { goBack(Unit) }),
                        LightBarButton.Text("SIGN IN", onClick = viewModel::begin),
                        LightBarButton.Text("DISCONNECT", onClick = viewModel::disconnect),
                    )
                })
            }
        }
    }
}
