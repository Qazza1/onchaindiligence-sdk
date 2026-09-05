export function pending(operationId, info) {
    return { kind: 'pending', operationId, ...info };
}
