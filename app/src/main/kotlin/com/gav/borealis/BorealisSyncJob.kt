package com.gav.borealis

import com.thelightphone.sdk.LightJob
import com.thelightphone.sdk.LightJobHandler
import com.thelightphone.sdk.LightJobResult

const val BOREALIS_SYNC_JOB = "borealis-sync"

@LightJob(BOREALIS_SYNC_JOB)
val borealisSyncJob: LightJobHandler = { context, _ ->
    val result = BorealisServices.from(context).repository.syncAndUpdate()
    result.fold(
        onSuccess = { summary ->
            LightJobResult.Success(mapOf("message" to summary.message))
        },
        onFailure = { error ->
            LightJobResult.Retry
        },
    )
}
