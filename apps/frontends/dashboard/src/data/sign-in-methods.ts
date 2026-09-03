import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1UserSignInMethodsByMethodIdMutation,
  getV1UserSignInMethodsOptions,
  getV1UserSignInMethodsQueryKey,
  postV1UserSignInMethodsAuthorizeMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export function useSignInMethods() {
  return useQuery(getV1UserSignInMethodsOptions())
}

export function useBeginSignInMethodAuthorization() {
  return useMutation({
    ...postV1UserSignInMethodsAuthorizeMutation(),
    onSuccess: ({ authorizationUrl }) => {
      window.location.assign(authorizationUrl)
    },
  })
}

export function useUnlinkSignInMethod() {
  const client = useQueryClient()
  return useMutation({
    ...deleteV1UserSignInMethodsByMethodIdMutation(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: getV1UserSignInMethodsQueryKey() })
    },
  })
}

export function signInMethodDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(value)
}
