export interface ShardLocation {
    index: number;
    nodeName: string;
    path: string;
    hash: string;
    objectId: string;
}

export interface ObjectMetaData {
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    paddingSize: number;
    createdAt: string;
    shards: ShardLocation[];
}