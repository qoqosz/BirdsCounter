// Share extension: takes the image another app shares, leaves it in the App Group container
// and opens BirdsCounter (birdscounter://shared), whose BCNativeBridge picks it up and counts.
// The app also looks in the container whenever it becomes active, so a share is not lost when
// opening the app from here fails.

#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <objc/message.h>

static NSString *const kAppGroup = @"group.com.birdscounter.app";

@interface ShareViewController : UIViewController
@end

@implementation ShareViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  UIActivityIndicatorView *spinner =
      [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleLarge];
  spinner.center = self.view.center;
  spinner.autoresizingMask = UIViewAutoresizingFlexibleTopMargin |
                             UIViewAutoresizingFlexibleBottomMargin |
                             UIViewAutoresizingFlexibleLeftMargin |
                             UIViewAutoresizingFlexibleRightMargin;
  [spinner startAnimating];
  [self.view addSubview:spinner];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  NSItemProvider *provider = nil;
  NSString *type = nil;
  for (NSExtensionItem *item in self.extensionContext.inputItems) {
    for (NSItemProvider *candidate in item.attachments) {
      for (NSString *identifier in candidate.registeredTypeIdentifiers) {
        UTType *utType = [UTType typeWithIdentifier:identifier];
        if (utType && [utType conformsToType:UTTypeImage]) {
          provider = candidate;
          type = identifier;
          break;
        }
      }
      if (provider) break;
    }
    if (provider) break;
  }
  if (!provider) {
    [self finish];
    return;
  }
  [provider loadFileRepresentationForTypeIdentifier:type
                                  completionHandler:^(NSURL *url, NSError *error) {
                                    // The file is deleted when this block returns.
                                    BOOL saved = url && [self save:url];
                                    dispatch_async(dispatch_get_main_queue(), ^{
                                      if (saved) [self openHostApp];
                                      [self finish];
                                    });
                                  }];
}

- (BOOL)save:(NSURL *)source {
  NSFileManager *files = NSFileManager.defaultManager;
  NSURL *container = [files containerURLForSecurityApplicationGroupIdentifier:kAppGroup];
  if (!container) return NO;
  NSURL *directory = [container URLByAppendingPathComponent:@"Shared" isDirectory:YES];
  [files removeItemAtURL:directory error:nil];
  [files createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil];
  NSDateFormatter *formatter = [NSDateFormatter new];
  formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
  formatter.dateFormat = @"yyyyMMdd_HHmmss";
  NSString *extension = source.pathExtension.length ? source.pathExtension : @"jpg";
  NSString *name = [NSString stringWithFormat:@"share_%@.%@", [formatter stringFromDate:[NSDate date]], extension];
  return [files copyItemAtURL:source toURL:[directory URLByAppendingPathComponent:name] error:nil];
}

// Extensions cannot call UIApplication directly; walk the responder chain to it.
- (void)openHostApp {
  NSURL *url = [NSURL URLWithString:@"birdscounter://shared"];
  SEL open = NSSelectorFromString(@"openURL:options:completionHandler:");
  for (UIResponder *responder = self; responder; responder = responder.nextResponder) {
    if ([responder isKindOfClass:UIApplication.class] && [responder respondsToSelector:open]) {
      ((void (*)(id, SEL, NSURL *, NSDictionary *, id))objc_msgSend)(responder, open, url, @{}, nil);
      return;
    }
  }
}

- (void)finish {
  [self.extensionContext completeRequestReturningItems:@[] completionHandler:nil];
}

@end
