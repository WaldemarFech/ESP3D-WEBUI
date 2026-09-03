import { getHttpFailureMessage } from "../types/http.types"
import type { HttpFailure } from "../types/http.types"

interface SerialFailureDependencies {
    stopCatchResponse: () => void
    stopLoading: () => void
    showError: (message: string) => void
}

export const createSerialFailureHandler = ({
    stopCatchResponse,
    stopLoading,
    showError,
}: SerialFailureDependencies): ((error: HttpFailure) => void) => {
    return (error: HttpFailure): void => {
        stopCatchResponse()
        stopLoading()
        showError(getHttpFailureMessage(error))
    }
}
