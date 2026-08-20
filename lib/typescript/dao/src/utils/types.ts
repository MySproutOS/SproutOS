// Allows setting properties of an object to be optional
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>
