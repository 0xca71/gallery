import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/models/server_info/server_features.model.dart';
import 'package:immich_mobile/utils/openapi_patching.dart';
import 'package:openapi/api.dart';

void main() {
  group('Test OpenApi Patching', () {
    test('upgradeDto', () {
      dynamic value;
      String targetType;

      targetType = 'UserPreferencesResponseDto';
      value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");

      upgradeDto(value, targetType);
      expect(value['tags'], TagsResponse(enabled: false, sidebarWeb: false).toJson());
      expect(value['download']['includeEmbeddedVideos'], false);
    });

    // Payloads below carry only the keys a stock Immich v3.3.1 server sends; fromJson must
    // fill the fork-only required ones through upgradeDto instead of throwing.
    test('parses stock Immich /server/features', () {
      final dto = ServerFeaturesDto.fromJson({
        'configFile': false,
        'duplicateDetection': true,
        'email': false,
        'facialRecognition': true,
        'importFaces': false,
        'map': false,
        'oauth': true,
        'oauthAutoLaunch': false,
        'ocr': true,
        'passwordLogin': false,
        'realtimeTranscoding': false,
        'reverseGeocoding': true,
        'search': true,
        'sidecar': true,
        'smartSearch': true,
        'trash': false,
      })!;
      final features = ServerFeatures.fromDto(dto);

      expect(dto.peopleStatistics, false);
      expect(dto.smartSearchHasCutoff, false);
      expect(features.oauthEnabled, true);
      expect(features.passwordLogin, false);
      expect(features.map, false);
      expect(features.trash, false);
      expect(features.ocr, true);
      expect(features.syncRequestTypes, isNull);
      expect(features.localTakenRange, false);
    });

    test('parses stock Immich /users/me/preferences', () {
      final dto = UserPreferencesResponseDto.fromJson(
        jsonDecode("""
{
  "albums": {"defaultAssetOrder": "desc"},
  "folders": {"enabled": false, "sidebarWeb": false},
  "memories": {"enabled": false, "duration": 7, "sidebarWeb": false},
  "people": {"enabled": true, "sidebarWeb": false, "minimumFaces": 3, "updateStrategy": "everyone"},
  "sharedLinks": {"enabled": true, "sidebarWeb": false},
  "ratings": {"enabled": false},
  "tags": {"enabled": false, "sidebarWeb": false},
  "emailNotifications": {"enabled": true, "albumInvite": true, "albumUpdate": true},
  "download": {"archiveSize": 4294967296, "includeEmbeddedVideos": false},
  "purchase": {"showSupportBadge": true, "hideBuyButtonUntil": "2022-02-12T00:00:00.000Z"},
  "cast": {"gCastEnabled": false},
  "recentlyAdded": {"sidebarWeb": false}
}
"""),
      )!;

      expect(dto.memories.enabled, false);
      expect(dto.memories.duration, 7);
      expect(dto.memories.types, isEmpty);
    });

    group('older Gallery response compatibility', () {
      test('deserializes FFmpeg settings without Data Saver, retaining transcode settings', () {
        final response = _olderAdminSection('ffmpeg');
        final dto = AdminConfigFFmpegDto.fromJson(response)!;

        expect(_json(dto.dataSaver), {
          'enabled': false,
          'targetVideoCodec': 'hevc',
          'targetResolution': '720',
          'maxBitrate': '1500k',
        });
        expect(_json(dto)..remove('dataSaver'), _olderAdminSection('ffmpeg'));
      });

      test('preserves enabled and disabled Data Saver with nondefault encoding settings', () {
        for (final enabled in [true, false]) {
          final response = _olderAdminSection('ffmpeg');
          response['dataSaver'] = {
            'enabled': enabled,
            'targetVideoCodec': 'av1',
            'targetResolution': '480',
            'maxBitrate': '800k',
          };

          expect(_json(AdminConfigFFmpegDto.fromJson(response)!), response);
        }
      });

      test('deserializes older ML settings with all new processing disabled', () {
        final dto = AdminConfigMachineLearningDto.fromJson(_olderAdminSection('machineLearning'))!;

        expect(_json(dto.facialRecognition.video), {
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
        });
        expect(_json(dto.petDetection.video), {
          'enabled': false,
          'sampleInterval': 2,
          'sceneDetection': true,
          'maxFrames': 900,
          'maxDistance': 0.55,
          'minSightings': 2,
        });
        expect(_json(dto.spatialScene), {
          'enabled': false,
          'modelName': 'depth-anything-v2-small',
          'offer': 'suitable',
          'minBoundarySharpness': 0.03,
          'minEdgeDensity': 0.02,
          'minForegroundRatio': 0.01,
          'maxForegroundRatio': 0.75,
          'minFaceHeight': 0.03,
        });
        final existingSettings = _json(dto)..remove('spatialScene');
        (existingSettings['facialRecognition'] as Map).remove('video');
        (existingSettings['petDetection'] as Map).remove('video');
        expect(existingSettings, _olderAdminSection('machineLearning'));
        expect(dto.enabled, isFalse);
        expect(dto.petDetection.enabled, isFalse);
        expect(dto.facialRecognition.suggestions.enabled, isFalse);
      });

      test('preserves newer ML settings, including explicit false flags and zero thresholds', () {
        for (final enabled in [true, false]) {
          final response = _olderAdminSection('machineLearning');
          (response['facialRecognition'] as Map)['video'] = {
            'enabled': enabled,
            'sampleInterval': 3.5,
            'sceneDetection': false,
            'maxFrames': 600,
            'tiledDetection': true,
            'maxDistance': 0.4,
            'minFaceSize': 0,
            'minSightings': 3,
            'createPeople': false,
            'minRecognitionScore': 0,
          };
          (response['petDetection'] as Map)['video'] = {
            'enabled': enabled,
            'sampleInterval': 4.5,
            'sceneDetection': false,
            'maxFrames': 300,
            'maxDistance': 0.65,
            'minSightings': 4,
          };
          response['spatialScene'] = {
            'enabled': enabled,
            'modelName': 'depth-anything-v2-base',
            'offer': 'all',
            'minBoundarySharpness': 0,
            'minEdgeDensity': 0.05,
            'minForegroundRatio': 0.1,
            'maxForegroundRatio': 0.9,
            'minFaceHeight': 0,
          };

          expect(_json(AdminConfigMachineLearningDto.fromJson(response)!), response);
        }
      });

      test('deserializes old job settings without changing existing concurrency', () {
        final dto = AdminConfigJobDto.fromJson(_olderAdminSection('job'))!;

        expect(dto.qualityAnalysis.concurrency, 2);
        expect(dto.spatialScene.concurrency, 1);
        expect(
          _json(dto)
            ..remove('qualityAnalysis')
            ..remove('spatialScene'),
          _olderAdminSection('job'),
        );
      });

      test('preserves newer quality and spatial queue concurrency', () {
        final response = _olderAdminSection('job');
        response['qualityAnalysis'] = {'concurrency': 7};
        response['spatialScene'] = {'concurrency': 4};

        expect(_json(AdminConfigJobDto.fromJson(response)!), response);
      });

      test('deserializes old queue responses with empty inactive new queues', () {
        final dto = QueuesResponseLegacyDto.fromJson(_compatibilityFixture('older-queues'))!;
        final emptyQueue = {
          'jobCounts': {'active': 0, 'completed': 0, 'delayed': 0, 'failed': 0, 'paused': 0, 'waiting': 0},
          'queueStatus': {'isActive': false, 'isPaused': false},
        };

        expect(_json(dto.qualityAnalysis), emptyQueue);
        expect(_json(dto.spatialScene), emptyQueue);
        expect(
          _json(dto)
            ..remove('qualityAnalysis')
            ..remove('spatialScene'),
          _compatibilityFixture('older-queues'),
        );
        expect(dto.faceDetection.jobCounts.active, 2);
        expect(dto.smartSearch.queueStatus.isPaused, isTrue);
      });

      test('preserves newer queue counts and active or paused status', () {
        final response = _compatibilityFixture('older-queues');
        response['qualityAnalysis'] = {
          'jobCounts': {'active': 2, 'completed': 40, 'delayed': 3, 'failed': 1, 'paused': 0, 'waiting': 8},
          'queueStatus': {'isActive': true, 'isPaused': false},
        };
        response['spatialScene'] = {
          'jobCounts': {'active': 0, 'completed': 20, 'delayed': 1, 'failed': 2, 'paused': 6, 'waiting': 0},
          'queueStatus': {'isActive': false, 'isPaused': true},
        };

        expect(_json(QueuesResponseLegacyDto.fromJson(response)!), response);
      });
    });

    test('addDefault', () {
      final dynamic value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");
      String keys = 'download.unknownKey';
      dynamic defaultValue = 69420;

      addDefault(value, keys, defaultValue);
      expect(value['download']['unknownKey'], 69420);

      keys = 'alpha.beta';
      defaultValue = 'gamma';
      addDefault(value, keys, defaultValue);
      expect(value['alpha']['beta'], 'gamma');
    });

    test('addDefault with null', () {
      final dynamic value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");
      expect(value['download']['unknownKey'], isNull);
    });
  });
}

Map<String, dynamic> _compatibilityFixture(String name) =>
    jsonDecode(File('test/fixtures/openapi_compatibility/$name.json').readAsStringSync()) as Map<String, dynamic>;

Map<String, dynamic> _olderAdminSection(String name) =>
    (_compatibilityFixture('older-admin-sections')[name] as Map).cast<String, dynamic>();

Map<String, dynamic> _json(Object dto) => jsonDecode(jsonEncode(dto)) as Map<String, dynamic>;
