import { createSerializer } from '@azure/core-client';
import * as ConnectorMappers from 'botframework-connector/lib/connectorApi/models/mappers.js';
import { describe, expect, it } from 'vitest';
import { ensureTeamsConnectorEntitySerialization } from './teams-connector-serialization.js';

describe('Teams Bot Framework connector serialization', () => {
  it('preserves streaminfo extension fields on the actual Connector wire payload', () => {
    ensureTeamsConnectorEntitySerialization();
    const serializer = createSerializer(ConnectorMappers as any, false);
    const wire = serializer.serialize(
      ConnectorMappers.Activity,
      {
        type: 'typing',
        text: 'partial answer',
        entities: [
          {
            type: 'streaminfo',
            streamType: 'streaming',
            streamSequence: 2,
            streamId: 'server-stream-id',
          },
        ],
      },
      'Activity',
    ) as any;

    expect(wire.entities).toEqual([
      {
        type: 'streaminfo',
        streamType: 'streaming',
        streamSequence: 2,
        streamId: 'server-stream-id',
      },
    ]);
  });
});
