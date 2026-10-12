// Native iOS features for src-tauri/src/native.rs: the camera, the photo library picker and
// home screen quick actions. Rust looks this class up at runtime and passes two C callbacks
// to +installWithQuickActionHandler:imageHandler: before the app launches.
//
// Image results are JPEG with the orientation applied. Errors are short codes the frontend
// translates: camera-unavailable, camera-denied, photos-denied, photo-missing, photo-unreadable.

#import <AVFoundation/AVFoundation.h>
#import <Photos/Photos.h>
#import <PhotosUI/PhotosUI.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

typedef void (*BCQuickActionHandler)(const char *type);
typedef void (*BCImageHandler)(uint64_t request, const uint8_t *bytes, uint64_t length,
                               const char *assetId, const char *name, const char *error);

static BCQuickActionHandler gQuickActionHandler;
static BCImageHandler gImageHandler;
static IMP gOriginalWillConnect;
// Pickers hold their delegates weakly; these keep them alive while a picker is shown.
static NSMutableSet *gActiveRequests;

static void BCReport(uint64_t request, NSData *jpeg, NSString *assetId, NSString *name,
                     NSString *error) {
  if (!gImageHandler) return;
  gImageHandler(request, jpeg.bytes, jpeg.length, assetId.UTF8String, name.UTF8String,
                error.UTF8String);
}

// Rotates the pixels upright instead of relying on EXIF orientation, so the web view, the
// crop rectangle and OpenCV all see the same image.
static NSData *BCJPEGData(UIImage *image) {
  if (!image) return nil;
  if (image.imageOrientation != UIImageOrientationUp) {
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
    format.scale = image.scale;
    format.opaque = YES;
    format.preferredRange = UIGraphicsImageRendererFormatRangeStandard;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:image.size
                                                                               format:format];
    image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
      [image drawInRect:(CGRect){CGPointZero, image.size}];
    }];
  }
  return UIImageJPEGRepresentation(image, 0.92);
}

static void BCReportImage(uint64_t request, UIImage *image, NSString *assetId, NSString *name) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSData *jpeg = BCJPEGData(image);
    BCReport(request, jpeg, assetId, name, jpeg ? nil : @"photo-unreadable");
  });
}

static UIViewController *BCTopViewController(void) {
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *candidate in ((UIWindowScene *)scene).windows) {
      if (candidate.isKeyWindow || !window) window = candidate;
    }
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  if (!window) window = UIApplication.sharedApplication.windows.firstObject;
#pragma clang diagnostic pop
  UIViewController *controller = window.rootViewController;
  while (controller.presentedViewController) controller = controller.presentedViewController;
  return controller;
}

static void BCHandleShortcut(UIApplicationShortcutItem *item) {
  if (gQuickActionHandler && item.type) gQuickActionHandler(item.type.UTF8String);
}

// -[AppDelegate application:performActionForShortcutItem:completionHandler:]
static void BCApplicationPerformAction(id self, SEL _cmd, UIApplication *application,
                                       UIApplicationShortcutItem *item,
                                       void (^completion)(BOOL)) {
  BCHandleShortcut(item);
  if (completion) completion(YES);
}

// -[TaoSceneDelegate windowScene:performActionForShortcutItem:completionHandler:]
static void BCScenePerformAction(id self, SEL _cmd, UIWindowScene *scene,
                                 UIApplicationShortcutItem *item, void (^completion)(BOOL)) {
  BCHandleShortcut(item);
  if (completion) completion(YES);
}

// -[TaoSceneDelegate scene:willConnectToSession:options:]: a quick action that launches the
// app on the scene lifecycle only arrives in the connection options.
static void BCSceneWillConnect(id self, SEL _cmd, UIScene *scene, UISceneSession *session,
                               UISceneConnectionOptions *options) {
  ((void (*)(id, SEL, UIScene *, UISceneSession *, UISceneConnectionOptions *))
       gOriginalWillConnect)(self, _cmd, scene, session, options);
  if (options.shortcutItem) BCHandleShortcut(options.shortcutItem);
}

@interface BCImageRequest
    : NSObject <UIImagePickerControllerDelegate, UINavigationControllerDelegate,
                PHPickerViewControllerDelegate>
@property(nonatomic) uint64_t requestId;
@end

@implementation BCImageRequest

+ (instancetype)requestWithId:(uint64_t)requestId {
  BCImageRequest *request = [BCImageRequest new];
  request.requestId = requestId;
  [gActiveRequests addObject:request];
  return request;
}

- (void)imagePickerController:(UIImagePickerController *)picker
    didFinishPickingMediaWithInfo:(NSDictionary<UIImagePickerControllerInfoKey, id> *)info {
  UIImage *image = info[UIImagePickerControllerOriginalImage];
  NSDateFormatter *formatter = [NSDateFormatter new];
  formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
  formatter.dateFormat = @"yyyyMMdd_HHmmss";
  NSString *name = [NSString
      stringWithFormat:@"BirdsCounter_%@.jpg", [formatter stringFromDate:[NSDate date]]];
  [picker dismissViewControllerAnimated:YES completion:nil];
  BCReportImage(self.requestId, image, nil, name);
  [gActiveRequests removeObject:self];
}

- (void)imagePickerControllerDidCancel:(UIImagePickerController *)picker {
  [picker dismissViewControllerAnimated:YES completion:nil];
  BCReport(self.requestId, nil, nil, nil, nil);
  [gActiveRequests removeObject:self];
}

- (void)picker:(PHPickerViewController *)picker
    didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  uint64_t requestId = self.requestId;
  PHPickerResult *result = results.firstObject;
  NSItemProvider *provider = result.itemProvider;
  if (!result) {
    BCReport(requestId, nil, nil, nil, nil);
  } else if (![provider canLoadObjectOfClass:UIImage.class]) {
    BCReport(requestId, nil, nil, nil, @"photo-unreadable");
  } else {
    // Set because the picker was created with the shared photo library; it lets the
    // history open the photo again later without keeping a copy.
    NSString *assetId = result.assetIdentifier;
    NSString *name = provider.suggestedName;
    [provider loadObjectOfClass:UIImage.class
              completionHandler:^(id<NSItemProviderReading> object, NSError *error) {
                UIImage *image = [(NSObject *)object isKindOfClass:UIImage.class]
                                     ? (UIImage *)object
                                     : nil;
                BCReportImage(requestId, image, assetId, name);
              }];
  }
  [gActiveRequests removeObject:self];
}

@end

@interface BCNativeBridge : NSObject
@end

@implementation BCNativeBridge

+ (void)installWithQuickActionHandler:(void *)quickActionHandler imageHandler:(void *)imageHandler {
  gQuickActionHandler = (BCQuickActionHandler)quickActionHandler;
  gImageHandler = (BCImageHandler)imageHandler;
  gActiveRequests = [NSMutableSet set];

  // Tao declares both delegates at runtime; add the quick action callbacks to them.
  Class appDelegate = NSClassFromString(@"AppDelegate");
  if (appDelegate) {
    class_replaceMethod(appDelegate,
                        @selector(application:performActionForShortcutItem:completionHandler:),
                        (IMP)BCApplicationPerformAction, "v@:@@@?");
  }
  Class sceneDelegate = NSClassFromString(@"TaoSceneDelegate");
  if (sceneDelegate) {
    class_replaceMethod(sceneDelegate,
                        @selector(windowScene:performActionForShortcutItem:completionHandler:),
                        (IMP)BCScenePerformAction, "v@:@@@?");
    Method willConnect =
        class_getInstanceMethod(sceneDelegate, @selector(scene:willConnectToSession:options:));
    if (willConnect && !gOriginalWillConnect) {
      gOriginalWillConnect = method_setImplementation(willConnect, (IMP)BCSceneWillConnect);
    }
  }
}

// JSON array of {"type", "title", "icon"} where icon is an SF Symbol name.
+ (void)setQuickActions:(char *)json {
  NSData *data = [NSData dataWithBytes:json length:strlen(json)];
  NSArray *items = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![items isKindOfClass:NSArray.class]) return;
  NSMutableArray<UIApplicationShortcutItem *> *shortcuts = [NSMutableArray array];
  for (NSDictionary *item in items) {
    if (![item isKindOfClass:NSDictionary.class]) continue;
    UIApplicationShortcutIcon *icon =
        [UIApplicationShortcutIcon iconWithSystemImageName:item[@"icon"]];
    [shortcuts addObject:[[UIApplicationShortcutItem alloc] initWithType:item[@"type"]
                                                          localizedTitle:item[@"title"]
                                                       localizedSubtitle:nil
                                                                    icon:icon
                                                                userInfo:nil]];
  }
  UIApplication.sharedApplication.shortcutItems = shortcuts;
}

+ (void)takePhoto:(uint64_t)requestId {
  if (![UIImagePickerController isSourceTypeAvailable:UIImagePickerControllerSourceTypeCamera]) {
    BCReport(requestId, nil, nil, nil, @"camera-unavailable");
    return;
  }
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) {
    BCReport(requestId, nil, nil, nil, @"camera-denied");
    return;
  }
  UIImagePickerController *picker = [UIImagePickerController new];
  picker.sourceType = UIImagePickerControllerSourceTypeCamera;
  picker.delegate = [BCImageRequest requestWithId:requestId];
  [BCTopViewController() presentViewController:picker animated:YES completion:nil];
}

+ (void)pickPhoto:(uint64_t)requestId {
  PHPickerConfiguration *configuration =
      [[PHPickerConfiguration alloc] initWithPhotoLibrary:PHPhotoLibrary.sharedPhotoLibrary];
  configuration.filter = PHPickerFilter.imagesFilter;
  configuration.selectionLimit = 1;
  PHPickerViewController *picker =
      [[PHPickerViewController alloc] initWithConfiguration:configuration];
  picker.delegate = [BCImageRequest requestWithId:requestId];
  [BCTopViewController() presentViewController:picker animated:YES completion:nil];
}

// Opens a photo library asset again by its local identifier; this needs library access.
+ (void)loadAsset:(uint64_t)requestId identifier:(char *)identifier {
  NSString *assetId = [NSString stringWithUTF8String:identifier];
  void (^load)(void) = ^{
    PHAsset *asset = [PHAsset fetchAssetsWithLocalIdentifiers:@[ assetId ] options:nil].firstObject;
    if (!asset) {
      BCReport(requestId, nil, nil, nil, @"photo-missing");
      return;
    }
    PHImageRequestOptions *options = [PHImageRequestOptions new];
    options.networkAccessAllowed = YES;
    options.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat;
    options.version = PHImageRequestOptionsVersionCurrent;
    [PHImageManager.defaultManager
        requestImageDataAndOrientationForAsset:asset
                                       options:options
                                 resultHandler:^(NSData *data, NSString *dataUTI,
                                                 CGImagePropertyOrientation orientation,
                                                 NSDictionary *info) {
                                   UIImage *image = data ? [UIImage imageWithData:data] : nil;
                                   if (!image) {
                                     BCReport(requestId, nil, nil, nil, @"photo-unreadable");
                                     return;
                                   }
                                   BCReportImage(requestId, image, assetId, nil);
                                 }];
  };
  void (^handle)(PHAuthorizationStatus) = ^(PHAuthorizationStatus status) {
    if (status == PHAuthorizationStatusAuthorized || status == PHAuthorizationStatusLimited) {
      load();
    } else {
      BCReport(requestId, nil, nil, nil, @"photos-denied");
    }
  };
  PHAuthorizationStatus status =
      [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite];
  if (status == PHAuthorizationStatusNotDetermined) {
    [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelReadWrite handler:handle];
  } else {
    handle(status);
  }
}

@end
