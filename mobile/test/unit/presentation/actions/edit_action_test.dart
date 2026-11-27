import 'dart:convert';

import 'package:crop_image/crop_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/asset_edit.model.dart';
import 'package:immich_mobile/models/server_info/server_version.model.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/edit_asset.action.dart';
import 'package:immich_mobile/presentation/actions/edit_datetime.action.dart';
import 'package:immich_mobile/presentation/actions/edit_location.action.dart';
import 'package:immich_mobile/presentation/pages/edit/edit.page.dart';
import 'package:immich_mobile/presentation/pages/edit/editor.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/utils/option.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:mocktail/mocktail.dart';

import '../../../riverpod_mocks.dart';
import '../../../service.mocks.dart';
import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

void main() {
  late PresentationContext context;
  late MockAssetService assetService;

  setUp(() async {
    context = await PresentationContext.create();
    assetService = context.service.asset.service;
  });

  tearDown(() async {
    await context.dispose();
  });

  RemoteAsset owned({AssetType type = .image}) =>
      RemoteAssetFactory.create(ownerId: context.currentUser.id, type: type);

  const supportedVersion = ServerVersion(major: 2, minor: 6, patch: 0);

  List<Override> reportedVersion(ServerVersion version) => [
    serverInfoProvider.overrideWith((ref) => StubServerInfoNotifier(context.service.serverInfo, version: version)),
  ];

  late BuildContext actionContext;
  late WidgetRef actionRef;

  Future<void> pumpAction(
    WidgetTester tester,
    ActionBuilder action,
    Set<BaseAsset> selection, {
    List<Override> overrides = const [],
  }) => tester.pumpTestWidget(
    context,
    Consumer(
      builder: (widgetContext, ref, _) {
        actionContext = widgetContext;
        actionRef = ref;
        return ActionIconButton(action: action);
      },
    ),
    overrides: [...context.selected(selection), ...overrides],
  );

  group('EditAssetAction', () {
    Future<void> pumpEditAsset(
      WidgetTester tester,
      Set<BaseAsset> selection, {
      ServerVersion version = supportedVersion,
    }) => pumpAction(
      tester,
      const EditAssetAction(source: .timeline),
      selection,
      overrides: [...reportedVersion(version)],
    );

    testWidgets('offers to edit a single owned editable asset', (tester) async {
      await pumpEditAsset(tester, {owned()});

      expect(find.byType(ImmichIconButton), findsOneWidget);
    });

    testWidgets('is hidden when the server predates edit sync', (tester) async {
      await pumpEditAsset(tester, {owned()}, version: const ServerVersion(major: 2, minor: 5, patch: 9));

      expect(find.byType(ImmichIconButton), findsNothing);
    });

    testWidgets('is hidden for more than one asset', (tester) async {
      await pumpEditAsset(tester, {owned(), owned()});

      expect(find.byType(ImmichIconButton), findsNothing);
    });

    testWidgets('is hidden for an asset owned by someone else', (tester) async {
      await pumpEditAsset(tester, {RemoteAssetFactory.create()});

      expect(find.byType(ImmichIconButton), findsNothing);
    });

    testWidgets('is hidden for a non-editable asset', (tester) async {
      await pumpEditAsset(tester, {owned(type: .video)});

      expect(find.byType(ImmichIconButton), findsNothing);
    });

    testWidgets('reads the edits and exif for the asset it is about to open', (tester) async {
      final asset = owned();

      await pumpEditAsset(tester, {asset});
      await tester.tap(find.byType(ImmichIconButton));
      await tester.pump();

      verify(() => context.repository.remoteAsset.repo.getAssetEdits(asset.id)).called(1);
      verify(() => context.repository.remoteAsset.repo.watchExif(asset.id)).called(1);
    });
  });

  group('EditImagePage rotation requests', () {
    for (final entry in <int, double?>{-450: 270, -360: null, -90: 270, 0: null, 90: 90, 450: 90, 720: null}.entries) {
      testWidgets('saves ${entry.key} degrees as ${entry.value ?? 'no rotation'}', (tester) async {
        final image = Image.memory(
          base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
        );
        List<AssetEdit>? appliedEdits;
        await tester.pumpTestWidget(
          context,
          Builder(
            builder: (pageContext) => ElevatedButton(
              onPressed: () => Navigator.of(pageContext).push(
                MaterialPageRoute<void>(
                  builder: (_) => EditImagePage(
                    image: image,
                    applyEdits: (edits) async {
                      appliedEdits = List.of(edits);
                    },
                  ),
                ),
              ),
              child: const Text('Open editor'),
            ),
          ),
          overrides: [editorStateProvider.overrideWith(() => _SeededEditor(entry.key))],
        );
        // The engine's image decoding needs real async time; fake-time pumping only animates
        // CropImage's loading spinner. Populate the cache before mounting its image listener.
        Object? imageError;
        await tester.runAsync(
          () => precacheImage(
            image.image,
            tester.element(find.text('Open editor')),
            onError: (error, _) => imageError = error,
          ),
        );
        expect(imageError, isNull);
        await tester.tap(find.text('Open editor'));
        await tester.pumpAndSettle();
        final decodedImage = tester.widget<CropImage>(find.byType(CropImage)).controller!.getImage();
        expect(decodedImage, isNotNull);
        expect(decodedImage!.width, 1);
        expect(decodedImage.height, 1);
        await tester.tap(find.byIcon(Icons.done_rounded));
        await tester.pumpAndSettle();

        expect(appliedEdits, isNotNull);
        if (entry.value == null) {
          expect(appliedEdits, isEmpty);
        } else {
          final edit = appliedEdits!.single as RotateEdit;
          expect(edit.parameters.angle, isA<double>());
          expect(edit.parameters.toJson(), {'angle': entry.value});
        }
        expect(find.text('Open editor'), findsOneWidget);
        // Let the successful save toast finish its three-second lifetime and FToast's fade
        // naturally, including timers that remain after the editor route has popped.
        await tester.pump(const Duration(seconds: 3));
        await tester.pump(const Duration(milliseconds: 350));
        await tester.pumpAndSettle();
        expect(find.byIcon(Icons.check_circle_rounded), findsNothing);
      });
    }
  });

  group('EditLocationAction', () {
    testWidgets('offers to edit an owned remote asset', (tester) async {
      await pumpAction(tester, const EditLocationAction(source: .timeline), {owned()});

      expect(find.byType(ImmichIconButton), findsOneWidget);
    });

    testWidgets('is hidden without any owned remote asset', (tester) async {
      await pumpAction(tester, const EditLocationAction(source: .timeline), {RemoteAssetFactory.create()});

      expect(find.byType(ImmichIconButton), findsNothing);
    });

    testWidgets('saves the location against every owned asset and toasts the count', (tester) async {
      final mine = owned();
      final theirs = RemoteAssetFactory.create();

      await pumpAction(tester, const EditLocationAction(source: .timeline), {mine, theirs});
      await saveLocation(actionContext, actionRef, [mine.id], const LatLng(1, 2));
      await tester.pumpAndSettle();

      final location =
          verify(() => assetService.update([mine.id], location: captureAny(named: 'location'))).captured.single
              as Option<LatLng>;
      expect(location.unwrapOrNull?.latitude, 1);
      expect(location.unwrapOrNull?.longitude, 2);
    });
  });

  group('EditDateTimeAction', () {
    testWidgets('offers to edit an owned remote asset', (tester) async {
      await pumpAction(tester, const EditDateTimeAction(source: .timeline), {owned()});

      expect(find.byType(ImmichIconButton), findsOneWidget);
    });

    testWidgets('is hidden without any owned remote asset', (tester) async {
      await pumpAction(tester, const EditDateTimeAction(source: .timeline), {RemoteAssetFactory.create()});

      expect(find.byType(ImmichIconButton), findsNothing);
    });

    testWidgets('saves the date against every owned asset and toasts the count', (tester) async {
      const picked = '2026-06-10T19:15:00.000+06:00';
      final mine = owned();
      final theirs = RemoteAssetFactory.create();

      await pumpAction(tester, const EditDateTimeAction(source: .timeline), {mine, theirs});
      await saveDateTime(actionContext, actionRef, [mine.id], picked);
      await tester.pumpAndSettle();

      verify(() => assetService.update([mine.id], dateTime: const Some(picked))).called(1);
    });
  });
}

class _SeededEditor extends EditorProvider {
  _SeededEditor(this.angle);

  final int angle;

  @override
  EditorState build() => EditorState(rotationAngle: angle, originalWidth: 1, originalHeight: 1, hasUnsavedEdits: true);
}
