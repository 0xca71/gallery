import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/openapi_patching.dart';

void main() {
  for (final dto in ['PublicConfigDto', 'ServerConfigDto']) {
    group(dto, () {
      test('older server responses default the delete-notice threshold to 20', () {
        final response = <String, dynamic>{};
        upgradeDto(response, dto);
        expect(response['webDeleteToastThreshold'], 20);
      });

      test('preserves the server-projected threshold, including zero', () {
        for (final threshold in [0, 42]) {
          final response = <String, dynamic>{'webDeleteToastThreshold': threshold};
          upgradeDto(response, dto);
          expect(response['webDeleteToastThreshold'], threshold);
        }
      });
    });
  }
}
