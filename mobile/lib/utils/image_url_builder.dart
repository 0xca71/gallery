import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:openapi/api.dart';

String getOriginalUrlForRemoteId(final String id, {bool edited = true, DateTime? updatedAt}) {
  final url = '${Store.get(StoreKey.serverEndpoint)}/assets/$id/original?edited=$edited';
  return updatedAt == null ? url : '$url&v=${updatedAt.microsecondsSinceEpoch}';
}

String getThumbnailUrlForRemoteId(
  final String id, {
  AssetMediaSize type = AssetMediaSize.thumbnail,
  bool edited = true,
  String? thumbhash,
  DateTime? updatedAt,
}) {
  final url = '${Store.get(StoreKey.serverEndpoint)}/assets/$id/thumbnail?size=$type&edited=$edited';
  final cached = thumbhash != null ? '$url&c=${Uri.encodeComponent(thumbhash)}' : url;
  return updatedAt == null ? cached : '$cached&v=${updatedAt.microsecondsSinceEpoch}';
}

String getPlaybackUrlForRemoteId(final String id) {
  return '${Store.get(StoreKey.serverEndpoint)}/assets/$id/video/playback?';
}

String getFaceThumbnailUrl(final String personId, {DateTime? updatedAt}) {
  final url = '${Store.get(StoreKey.serverEndpoint)}/people/$personId/thumbnail';
  return updatedAt != null ? '$url?c=${updatedAt.millisecondsSinceEpoch}' : url;
}
