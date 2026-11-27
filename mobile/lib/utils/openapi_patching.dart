import 'package:flutter/foundation.dart';
import 'package:openapi/api.dart';

abstract interface class _Dynamic {
  Object? resolve();
}

class _CurrentTimestamp implements _Dynamic {
  const _CurrentTimestamp();

  @override
  Object? resolve() => DateTime.now().toIso8601String();
}

const _now = _CurrentTimestamp();

@visibleForTesting
final Map<String, Map<String, Object?>> openApiPatches = {
  'UserPreferencesResponseDto': {
    'download.includeEmbeddedVideos': false,
    'folders': FoldersResponse(enabled: false, sidebarWeb: false).toJson(),
    'memories': MemoriesResponse(enabled: true, duration: 5, sidebarWeb: false).toJson(),
    'ratings': RatingsResponse(enabled: false).toJson(),
    'people': PeopleResponse(enabled: true, sidebarWeb: false, updateStrategy: PersonUpdateStrategy.everyone).toJson(),
    'tags': TagsResponse(enabled: false, sidebarWeb: false).toJson(),
    'sharedLinks': SharedLinksResponse(enabled: true, sidebarWeb: false).toJson(),
    'cast': CastResponse(gCastEnabled: false).toJson(),
    'albums': {'defaultAssetOrder': 'desc'},
    'recentlyAdded': RecentlyAddedResponse(sidebarWeb: false).toJson(),
  },
  'PublicConfigDto': {
    'map': PublicConfigMapDto(
      enabled: true,
      lightStyle: 'https://tiles.immich.cloud/v1/style/light.json',
      darkStyle: 'https://tiles.immich.cloud/v1/style/dark.json',
    ).toJson(),
    'ffmpeg': PublicConfigFFmpegDto(realtime: PublicConfigFFmpegRealtimeDto(enabled: false)).toJson(),
    'passkey': {'enabled': false},
    'webDeleteToastThreshold': 20,
  },
  'ServerConfigDto': {
    'mapLightStyleUrl': 'https://tiles.openfreemap.org/styles/positron',
    'mapDarkStyleUrl': 'https://tiles.openfreemap.org/styles/dark',
    'minFaces': 3,
    'webDeleteToastThreshold': 20,
  },
  'UserResponseDto': {'profileChangedAt': _now},
  'AssetResponseDto': {'visibility': 'timeline', 'createdAt': _now, 'isEdited': false},
  'UserAdminResponseDto': {'profileChangedAt': _now, 'clusterGroupId': ''},
  'LoginResponseDto': {'isOnboarded': false},
  'SyncUserV1': {'profileChangedAt': _now, 'hasProfileImage': false},
  'SyncAssetV1': {'isEdited': false},
  'ServerFeaturesDto': {
    'ocr': false,
    'realtimeTranscoding': false,
    'backups': false,
    'peopleStatistics': false,
    'smartSearchHasCutoff': false,
    's3Storage': false,
  },
  // A raw map rather than the generated DTO: `enabled` is nullable there, and these are the
  // server-side defaults an older server would have behaved as (backups stay on local disk).
  'AdminConfigDatabaseBackupDto': {
    's3': const {'enabled': false},
  },
  'SearchAssetResponseDto': {'nextCursor': null},
  'MemoriesResponse': {'duration': 5, 'sidebarWeb': false, 'types': const <String, bool>{}},
  'PeopleResponse': {'updateStrategy': 'everyone'},
  'PersonResponseDto': {'otherPeople': const [], 'sharedBy': const [], 'sharedWith': const []},
  'ServerVersionResponseDto': {'featureLevel': 0},
  'WorkflowResponseDto': {'logging': false},
  'AdminConfigDto': {
    'passkey': {'enabled': false, 'domain': null, 'additionalDomains': const []},
  },
  // Older Gallery servers omit these sections. Keep the server defaults, with new features off.
  // Raw JSON also retains explicit false values for flags the generator represents as nullable.
  'AdminConfigFFmpegDto': {
    'dataSaver': const {'enabled': false, 'targetVideoCodec': 'hevc', 'targetResolution': '720', 'maxBitrate': '1500k'},
  },
  'AdminConfigFacialRecognitionDto': {
    'video': const {
      'enabled': false,
      'sampleInterval': 2,
      'sceneDetection': true,
      'maxFrames': 1800,
      'tiledDetection': false,
      'maxDistance': 0.5,
      'minFaceSize': 20,
      'minSightings': 1,
      'createPeople': true,
      'minRecognitionScore': 0.75,
    },
  },
  'AdminConfigJobDto': {
    'qualityAnalysis': const {'concurrency': 2},
    'spatialScene': const {'concurrency': 1},
  },
  'AdminConfigMachineLearningDto': {
    'spatialScene': const {
      'enabled': false,
      'modelName': 'depth-anything-v2-small',
      'offer': 'suitable',
      'minBoundarySharpness': 0.03,
      'minEdgeDensity': 0.02,
      'minForegroundRatio': 0.01,
      'maxForegroundRatio': 0.75,
      'minFaceHeight': 0.03,
    },
  },
  'AdminConfigPetDetectionDto': {
    'video': const {
      'enabled': false,
      'sampleInterval': 2,
      'sceneDetection': true,
      'maxFrames': 900,
      'maxDistance': 0.55,
      'minSightings': 2,
    },
  },
  'QueuesResponseLegacyDto': {
    'qualityAnalysis': const {
      'jobCounts': {'active': 0, 'completed': 0, 'delayed': 0, 'failed': 0, 'paused': 0, 'waiting': 0},
      'queueStatus': {'isActive': false, 'isPaused': false},
    },
    'spatialScene': const {
      'jobCounts': {'active': 0, 'completed': 0, 'delayed': 0, 'failed': 0, 'paused': 0, 'waiting': 0},
      'queueStatus': {'isActive': false, 'isPaused': false},
    },
  },
  'UserConfigDto': {
    'notifications': UserConfigNotificationsDto(smtp: UserConfigSmtpDto(enabled: false)).toJson(),
    'passkey': {'enabled': false},
  },
};

// ignore: unused-code
void upgradeDto(dynamic value, String targetType) {
  if (value is! Map) {
    return;
  }
  final fields = openApiPatches[targetType];
  if (fields == null) {
    return;
  }
  fields.forEach((key, defaultValue) {
    addDefault(value, key, defaultValue is _Dynamic ? defaultValue.resolve() : defaultValue);
  });
}

void addDefault(dynamic value, String keys, dynamic defaultValue) {
  // Loop through the keys and assign the default value if the key is not present
  final List<String> keyList = keys.split('.');
  dynamic current = value;

  for (int i = 0; i < keyList.length - 1; i++) {
    if (current[keyList[i]] == null) {
      current[keyList[i]] = {};
    }
    current = current[keyList[i]];
  }

  if (current[keyList.last] == null) {
    current[keyList.last] = defaultValue;
  }
}
