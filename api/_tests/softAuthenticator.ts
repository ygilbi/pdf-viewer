// Minimal software WebAuthn authenticator (ES256, "none" attestation) for tests: produces real
// RegistrationResponseJSON / AuthenticationResponseJSON that @simplewebauthn/server verifies cryptographically.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64u = (b: Uint8Array | Buffer | string) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface SoftAuthenticatorOptions {
  origin: string;
  /** Set false to simulate an authenticator that skipped user verification. */
  userVerified?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Uint8Array;
  counter = 0;
  userHandle: string | null = null;

  constructor(private opts: SoftAuthenticatorOptions) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]);
    this.cosePublicKey = isoCBOR.encode(cose);
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  set origin(o: string) {
    this.opts = { ...this.opts, origin: o };
  }

  private flags(extra = 0): number {
    return FLAG_UP | (this.opts.userVerified === false ? 0 : FLAG_UV) | extra;
  }

  private counterBytes(): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    return c;
  }

  /** navigator.credentials.create() equivalent. `options` = PublicKeyCredentialCreationOptionsJSON. */
  create(options: { challenge: string; rp: { id?: string }; user: { id: string } }) {
    const rpId = options.rp.id!;
    this.userHandle = options.user.id;
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(FLAG_AT)]),
      this.counterBytes(),
      Buffer.alloc(16), // aaguid
      credLen,
      this.credentialId,
      Buffer.from(this.cosePublicKey),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]) as never,
    );
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.opts.origin, crossOrigin: false });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal', 'hybrid'],
      },
    };
  }

  /** navigator.credentials.get() equivalent. `options` = PublicKeyCredentialRequestOptionsJSON. */
  get(options: { challenge: string; rpId?: string }, { bumpCounter = true } = {}) {
    if (bumpCounter) this.counter++;
    const authData = Buffer.concat([sha256(options.rpId!), Buffer.from([this.flags()]), this.counterBytes()]);
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.opts.origin, crossOrigin: false });
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey); // DER
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle,
      },
    };
  }
}
