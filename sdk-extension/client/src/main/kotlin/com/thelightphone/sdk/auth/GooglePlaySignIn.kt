package com.thelightphone.sdk.auth

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.thelightphone.sdk.SealedLightContext
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.delay

/** Experimental, sideload-only native account setup. Removing this view cancels the session. */
@Composable
fun SealedLightContext.GooglePlaySignIn(
    modifier: Modifier = Modifier,
    onCredential: (GooglePlaySignInCredential) -> Unit,
    onError: (String) -> Unit,
) {
    val credentialCallback = rememberUpdatedState(onCredential)
    val errorCallback = rememberUpdatedState(onError)
    val owner = LocalLifecycleOwner.current
    val window = LocalActivity.current?.window
    val session = remember(this) {
        GooglePlayWebSession(
            androidContext,
            onCredential = { credentialCallback.value(it) },
            onError = { errorCallback.value(it) },
        )
    }
    LaunchedEffect(session) {
        delay(5 * 60 * 1_000L)
        session.fail("Google sign-in timed out. Try again.", GooglePlayDiagnosticOutcome.TIMED_OUT)
    }
    DisposableEffect(session, owner, window) {
        val wasSecure = window?.attributes?.flags?.and(WindowManager.LayoutParams.FLAG_SECURE) != 0
        window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                session.fail(
                    "Google sign-in was closed when Borealis left the foreground. Try again.",
                    GooglePlayDiagnosticOutcome.CANCELLED,
                )
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            session.close()
            if (!wasSecure) window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }
    AndroidView(factory = { session.createView() }, modifier = modifier)
}

private class GooglePlayWebSession(
    private val context: Context,
    private val onCredential: (GooglePlaySignInCredential) -> Unit,
    private val onError: (String) -> Unit,
) {
    private var view: WebView? = null
    private val ended = AtomicBoolean(false)
    private var disposed = false
    private var navigationGeneration = 0L
    private var readingGeneration: Long? = null

    fun createView(): WebView {
        GooglePlayDiagnostics.record(GooglePlayDiagnosticStage.WEBVIEW, GooglePlayDiagnosticOutcome.STARTED)
        WebView.setWebContentsDebuggingEnabled(false)
        return WebView(context).also { browser ->
            view = browser
            browser.isSaveEnabled = false
            browser.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            browser.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                safeBrowsingEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = false
                @Suppress("DEPRECATION")
                allowUniversalAccessFromFileURLs = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                setGeolocationEnabled(false)
                cacheMode = WebSettings.LOAD_NO_CACHE
                mediaPlaybackRequiresUserGesture = true
                @Suppress("DEPRECATION")
                saveFormData = false
                @Suppress("DEPRECATION")
                savePassword = false
            }
            browser.webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage?): Boolean = true

                override fun onPermissionRequest(request: PermissionRequest) = request.deny()

                override fun onGeolocationPermissionsShowPrompt(
                    origin: String?, callback: GeolocationPermissions.Callback,
                ) = callback.invoke(origin, false, false)

                override fun onCreateWindow(
                    view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?,
                ): Boolean = false

                override fun onShowFileChooser(
                    webView: WebView?, filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams?,
                ): Boolean {
                    filePathCallback.onReceiveValue(null)
                    return true
                }
            }
            browser.setDownloadListener { _, _, _, _, _ ->
                fail("Downloads are not available during Google sign-in.", GooglePlayDiagnosticOutcome.NAVIGATION_BLOCKED)
            }
            browser.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView, request: WebResourceRequest,
                ): Boolean {
                    if (ended.get()) return true
                    if (!request.isForMainFrame) return !isHttpsResource(request.url.toString())
                    if (isGoogleAccountsUrl(request.url.toString())) return false
                    fail(
                        "Google sign-in requested an unsupported page. Sign-in was closed.",
                        GooglePlayDiagnosticOutcome.NAVIGATION_BLOCKED,
                    )
                    return true
                }

                @Suppress("DEPRECATION")
                override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                    if (!ended.get() && isGoogleAccountsUrl(url)) return false
                    fail(
                        "Google sign-in requested an unsupported page. Sign-in was closed.",
                        GooglePlayDiagnosticOutcome.NAVIGATION_BLOCKED,
                    )
                    return true
                }

                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest,
                ): WebResourceResponse? {
                    val url = request.url.toString()
                    val invalidMainFrame = request.isForMainFrame && !isGoogleAccountsUrl(url)
                    if (invalidMainFrame) {
                        view.post {
                            fail(
                                "Google sign-in requested an unsupported page. Sign-in was closed.",
                                GooglePlayDiagnosticOutcome.NAVIGATION_BLOCKED,
                            )
                        }
                    }
                    return if (ended.get() || invalidMainFrame || !isHttpsResource(url)) {
                        WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(byteArrayOf()))
                    } else null
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    navigationGeneration += 1
                    if (!isGoogleAccountsUrl(url)) {
                        fail(
                            "Google sign-in left the permitted account page. Sign-in was closed.",
                            GooglePlayDiagnosticOutcome.NAVIGATION_BLOCKED,
                        )
                    } else if (navigationGeneration > 1) {
                        GooglePlayDiagnostics.record(
                            GooglePlayDiagnosticStage.WEBVIEW_PAGE, GooglePlayDiagnosticOutcome.STARTED,
                        )
                    }
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    if (ended.get() || readingGeneration == navigationGeneration ||
                        !isGoogleAccountsUrl(url) || view.url != url
                    ) return
                    GooglePlayDiagnostics.record(
                        GooglePlayDiagnosticStage.WEBVIEW_PAGE, GooglePlayDiagnosticOutcome.SUCCEEDED,
                    )
                    val token = extractGoogleOauthCookie(
                        CookieManager.getInstance().getCookie(url),
                    ) ?: return
                    val generation = navigationGeneration
                    readingGeneration = generation
                    view.evaluateJavascript(PROFILE_EMAIL_SCRIPT) { result ->
                        if (readingGeneration == generation) readingGeneration = null
                        if (ended.get() || disposed || generation != navigationGeneration ||
                            view.url != url || !isGoogleAccountsUrl(view.url)
                        ) return@evaluateJavascript
                        val currentToken = extractGoogleOauthCookie(
                            CookieManager.getInstance().getCookie(url),
                        )
                        if (currentToken != token) return@evaluateJavascript
                        val email = extractGoogleProfileEmail(result) ?: return@evaluateJavascript
                        if (ended.compareAndSet(false, true)) {
                            cleanUp {
                                if (!disposed) {
                                    GooglePlayDiagnostics.record(
                                        GooglePlayDiagnosticStage.WEBVIEW, GooglePlayDiagnosticOutcome.SUCCEEDED,
                                    )
                                    onCredential(GooglePlaySignInCredential(email, token))
                                }
                            }
                        }
                    }
                }

                override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError?) {
                    handler.cancel()
                    fail(
                        "Google sign-in could not establish a secure connection.",
                        GooglePlayDiagnosticOutcome.NETWORK_ERROR,
                        error?.primaryError,
                    )
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) fail(
                        "Google sign-in could not load. Check your connection and try again.",
                        GooglePlayDiagnosticOutcome.NETWORK_ERROR,
                        error.errorCode,
                    )
                }

                override fun onReceivedHttpError(
                    view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse,
                ) {
                    if (request.isForMainFrame) fail(
                        "Google sign-in was refused or unavailable. Try again later.",
                        GooglePlayDiagnosticOutcome.HTTP_ERROR,
                        errorResponse.statusCode,
                    )
                }

                override fun onSafeBrowsingHit(
                    view: WebView?, request: WebResourceRequest?, threatType: Int, callback: SafeBrowsingResponse,
                ) {
                    callback.backToSafety(false)
                    fail(
                        "Google sign-in was blocked by Safe Browsing.",
                        GooglePlayDiagnosticOutcome.NAVIGATION_BLOCKED,
                        threatType,
                    )
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    fail("Google sign-in stopped unexpectedly. Try again.", GooglePlayDiagnosticOutcome.RENDERER_GONE)
                    return true
                }
            }
            val cookies = CookieManager.getInstance()
            cookies.setAcceptCookie(true)
            cookies.setAcceptThirdPartyCookies(browser, false)
            WebStorage.getInstance().deleteAllData()
            cookies.removeAllCookies {
                cookies.flush()
                if (!ended.get() && !disposed) {
                    GooglePlayDiagnostics.record(
                        GooglePlayDiagnosticStage.WEBVIEW_PAGE, GooglePlayDiagnosticOutcome.STARTED,
                    )
                    browser.loadUrl(GOOGLE_PLAY_SIGN_IN_URL)
                }
            }
        }
    }

    fun fail(message: String, outcome: GooglePlayDiagnosticOutcome, code: Int? = null) {
        if (ended.compareAndSet(false, true)) {
            GooglePlayDiagnostics.record(GooglePlayDiagnosticStage.WEBVIEW, outcome, code)
            cleanUp { if (!disposed) onError(message) }
        }
    }

    fun close() {
        disposed = true
        if (ended.compareAndSet(false, true)) {
            GooglePlayDiagnostics.record(GooglePlayDiagnosticStage.WEBVIEW, GooglePlayDiagnosticOutcome.CANCELLED)
            cleanUp()
        }
    }

    private fun cleanUp(afterCookiesCleared: () -> Unit = {}) {
        view?.let { browser ->
            view = null
            runCatching { browser.stopLoading() }
            runCatching { browser.clearHistory() }
            runCatching { browser.clearFormData() }
            runCatching { browser.clearCache(true) }
            (browser.parent as? ViewGroup)?.removeView(browser)
            browser.destroy()
        }
        WebStorage.getInstance().deleteAllData()
        val cookies = CookieManager.getInstance()
        cookies.removeAllCookies {
            cookies.flush()
            afterCookiesCleared()
        }
    }
}

// EmbeddedSetup account identifier also used by Aurora Store's GoogleLoginScreen.
private const val PROFILE_EMAIL_SCRIPT = """
    (function() {
        var account = document.querySelector('[data-profile-identifier][data-email]');
        return account ? account.getAttribute('data-email') : null;
    })();
"""
