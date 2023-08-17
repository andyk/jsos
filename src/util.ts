export function assert(condition: boolean, errorMessage: string): void {
    if (!condition) {
        throw Error(errorMessage);
    }
}
export function assertEqual(val1: any, val2: any, errorMessage: string): void {
    if (val1 !== val2) {
        throw Error(errorMessage);
    }
}

export function assertNotEqual(val1: any, val2: any, errorMessage: string): void {
    if (val1 === val2) {
        throw Error(errorMessage);
    }
}