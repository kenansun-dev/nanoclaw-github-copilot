/**
 * Restore Bot Framework Entity extension-field serialization.
 *
 * botframework-connector@4.23.3 declares `additionalProperties` on the
 * Activity.entities sequence element rather than on the Entity mapper itself.
 * @azure/core-client ignores it there, so ConnectorClient silently strips
 * Teams streaming fields (`streamType`, `streamSequence`, `streamId`) and sends
 * a bare `{ type: 'streaminfo' }` entity. Microsoft fixed the same regression
 * upstream in botbuilder-js PR #4903; keep this narrow runtime shim until a
 * botbuilder release containing that patch is available.
 */
import { Entity } from 'botframework-connector/lib/connectorApi/models/mappers.js';

export function ensureTeamsConnectorEntitySerialization(): void {
  const mapper = Entity as any;
  if (!mapper?.type?.modelProperties) {
    throw new Error('Teams: unexpected botframework-connector Entity mapper shape');
  }
  mapper.type.additionalProperties ??= {
    type: {
      name: 'Object',
    },
  };
}
