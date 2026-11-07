import { jwtHmac, localDev } from "eve/channels/auth"
import { eveChannel } from "eve/channels/eve"

/** Only Devon's server-side adapter may call the production Eve session API. */
export default eveChannel({
  auth: [
    jwtHmac({
      algorithm: "HS256",
      issuer: "devon-browser",
      audiences: ["devon-eve"],
      secret: process.env.DEVON_EVE_JWT_SECRET!,
    }),
    localDev(),
  ],
})
